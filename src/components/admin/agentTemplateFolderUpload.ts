import {
  MAX_TEMPLATE_FOLDER_BYTES,
  MAX_TEMPLATE_FOLDER_DEPTH,
  MAX_TEMPLATE_FOLDER_ENTRIES,
  MAX_TEMPLATE_FOLDERS,
} from '../../../shared/agentTemplateFolders.js';

export type AgentTemplateUploadedFile = {
  path: string;
  contentBase64: string;
  size?: never;
  sha256?: never;
  storagePath?: never;
};

export type AgentTemplateStoredFile = {
  path: string;
  size: number;
  sha256: string;
  storagePath: string;
  contentBase64?: never;
};

export type AgentTemplateFolder = {
  name: string;
  directories: string[];
  files: Array<AgentTemplateUploadedFile | AgentTemplateStoredFile>;
};

export type AgentTemplateUploadedFolder = Omit<AgentTemplateFolder, 'files'> & {
  files: AgentTemplateUploadedFile[];
};

export type FolderUploadEntry = {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  file?: (success: (file: File) => void, error: (error: DOMException) => void) => void;
  createReader?: () => {
    readEntries: (success: (entries: FolderUploadEntry[]) => void, error: (error: DOMException) => void) => void;
  };
};

const pathKey = (path: string) => path.normalize('NFC').toLowerCase();
const encoder = new TextEncoder();

function checkSegment(name: string) {
  if (!name || name === '.' || name === '..' || /[\\/\u0000-\u001f\u007f:*?"<>|]/.test(name)
    || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    || encoder.encode(name).length > 255) {
    throw new Error(`文件或文件夹名称不受支持：${name || '（空名称）'}`);
  }
}

function checkPath(path: string) {
  if (path.length > 2048) throw new Error(`文件路径过长：${path.slice(0, 80)}…`);
  const parts = path.split('/');
  if (parts.length > MAX_TEMPLATE_FOLDER_DEPTH) {
    throw new Error(`文件夹层级不能超过 ${MAX_TEMPLATE_FOLDER_DEPTH} 层：${path}`);
  }
  parts.forEach(checkSegment);
}

function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('已取消文件夹读取', 'AbortError');
}

export function templateFolderBytes(folder: AgentTemplateFolder) {
  return folder.files.reduce((total, file) => {
    if (typeof file.contentBase64 !== 'string') return total + file.size;
    return total + file.contentBase64.length * 3 / 4
      - (file.contentBase64.endsWith('==') ? 2 : file.contentBase64.endsWith('=') ? 1 : 0);
  }, 0);
}

export function formatTemplateFolderBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type PendingFolder = {
  name: string;
  directories: string[];
  files: Array<{ path: string; file: File }>;
  paths: Map<string, { path: string; kind: 'file' | 'directory' }>;
};

class FolderUploadBatch {
  folders: PendingFolder[] = [];
  private rootNames: Set<string>;
  private bytes: number;
  private entryCount: number;

  constructor(private existing: AgentTemplateFolder[], private signal?: AbortSignal) {
    this.rootNames = new Set(existing.map((folder) => pathKey(folder.name)));
    this.bytes = existing.reduce((sum, folder) => sum + templateFolderBytes(folder), 0);
    this.entryCount = existing.reduce((sum, folder) => sum + folder.directories.length + folder.files.length, 0);
  }

  addFolder(name: string) {
    checkAborted(this.signal);
    checkSegment(name);
    const key = pathKey(name);
    if (this.rootNames.has(key)) {
      throw new Error(`文件夹“${name}”已存在，请先移除同名文件夹再上传。`);
    }
    if (this.existing.length + this.folders.length >= MAX_TEMPLATE_FOLDERS) {
      throw new Error(`最多上传 ${MAX_TEMPLATE_FOLDERS} 个文件夹。`);
    }
    this.rootNames.add(key);
    const folder: PendingFolder = { name, directories: [], files: [], paths: new Map() };
    this.folders.push(folder);
    return folder;
  }

  private addPath(folder: PendingFolder, path: string, kind: 'file' | 'directory') {
    checkAborted(this.signal);
    checkPath(path);
    const previous = folder.paths.get(pathKey(path));
    if (previous) {
      if (kind === 'directory' && previous.kind === kind && previous.path === path) return false;
      throw new Error(`文件夹“${folder.name}”中存在重名或冲突路径：${path}`);
    }
    if (++this.entryCount > MAX_TEMPLATE_FOLDER_ENTRIES) {
      throw new Error(`文件和子文件夹合计不能超过 ${MAX_TEMPLATE_FOLDER_ENTRIES} 项。`);
    }
    folder.paths.set(pathKey(path), { path, kind });
    return true;
  }

  addDirectory(folder: PendingFolder, path: string) {
    const parts = path.split('/');
    checkPath(path);
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const directory = parts.slice(0, depth).join('/');
      if (this.addPath(folder, directory, 'directory')) folder.directories.push(directory);
    }
  }

  addFile(folder: PendingFolder, path: string, file: File) {
    checkPath(path);
    const parent = path.split('/').slice(0, -1).join('/');
    if (parent) this.addDirectory(folder, parent);
    this.addPath(folder, path, 'file');
    this.bytes += file.size;
    if (this.bytes > MAX_TEMPLATE_FOLDER_BYTES) {
      throw new Error(`所有文件夹的文件总大小不能超过 ${formatTemplateFolderBytes(MAX_TEMPLATE_FOLDER_BYTES)}。`);
    }
    folder.files.push({ path, file });
  }

  async encode(): Promise<AgentTemplateUploadedFolder[]> {
    const result: AgentTemplateUploadedFolder[] = [];
    for (const folder of this.folders) {
      const files: AgentTemplateUploadedFile[] = [];
      for (const { path, file } of folder.files) {
        checkAborted(this.signal);
        let content: ArrayBuffer;
        try {
          content = await file.arrayBuffer();
        } catch {
          throw new Error(`无法读取文件“${folder.name}/${path}”，请检查文件权限后重新上传。`);
        }
        checkAborted(this.signal);
        if (content.byteLength !== file.size) {
          throw new Error(`文件“${folder.name}/${path}”在读取时发生变化，请重新上传。`);
        }
        const bytes = new Uint8Array(content);
        const chunks: string[] = [];
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
        }
        files.push({ path, contentBase64: btoa(chunks.join('')) });
      }
      result.push({ name: folder.name, directories: folder.directories, files });
    }
    checkAborted(this.signal);
    return result;
  }
}

/** Directory picker paths include the selected root; parents must be reconstructed. */
export async function readTemplateFolderFiles(
  files: File[],
  existing: AgentTemplateFolder[] = [],
  signal?: AbortSignal,
): Promise<AgentTemplateUploadedFolder[]> {
  const batch = new FolderUploadBatch(existing, signal);
  const roots = new Map<string, PendingFolder>();
  for (const file of files) {
    const parts = file.webkitRelativePath.split('/');
    if (parts.length < 2) throw new Error('请选择文件夹；如需上传多个文件夹，可一起拖入上传区域。');
    const name = parts.shift()!;
    let folder = roots.get(name);
    if (!folder) {
      folder = batch.addFolder(name);
      roots.set(name, folder);
    }
    batch.addFile(folder, parts.join('/'), file);
  }
  return batch.encode();
}

/** Read each directory until an empty batch: browsers may return only 100 entries at once. */
export async function readTemplateFolderEntries(
  entries: FolderUploadEntry[],
  existing: AgentTemplateFolder[] = [],
  signal?: AbortSignal,
): Promise<AgentTemplateUploadedFolder[]> {
  const batch = new FolderUploadBatch(existing, signal);
  const visit = async (entry: FolderUploadEntry, folder: PendingFolder, path: string): Promise<void> => {
    checkAborted(signal);
    if (entry.isDirectory && entry.createReader) {
      if (path) batch.addDirectory(folder, path);
      const reader = entry.createReader();
      while (true) {
        checkAborted(signal);
        let children: FolderUploadEntry[];
        try {
          children = await new Promise<FolderUploadEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        } catch {
          throw new Error(`无法读取文件夹“${folder.name}${path ? `/${path}` : ''}”，请检查权限后重新上传。`);
        }
        if (children.length === 0) break;
        for (const child of children) {
          await visit(child, folder, path ? `${path}/${child.name}` : child.name);
        }
      }
    } else if (entry.isFile && entry.file) {
      checkPath(path);
      let file: File;
      try {
        file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject));
      } catch {
        throw new Error(`无法读取文件“${folder.name}/${path}”，请检查权限后重新上传。`);
      }
      batch.addFile(folder, path, file);
    } else {
      throw new Error(`无法读取“${entry.name}”，请使用文件夹选择按钮重试。`);
    }
  };
  for (const entry of entries) {
    if (!entry.isDirectory) throw new Error('请拖入文件夹，暂不支持单独上传文件。');
    await visit(entry, batch.addFolder(entry.name), '');
  }
  return batch.encode();
}
