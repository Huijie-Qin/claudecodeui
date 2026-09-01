export const SKILL_UPLOAD_SINGLE_FILE_ERROR = '每次只能上传一个 ZIP 文件。';
export const SKILL_UPLOAD_ZIP_ONLY_ERROR = '仅支持 ZIP 文件。';

type SkillUploadFile = Pick<File, 'name' | 'type'>;

export type SkillUploadSelection<TFile extends SkillUploadFile = File> = {
  file: TFile | null;
  error: string | null;
};

const ZIP_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
]);

export function selectSkillUploadArchive<TFile extends SkillUploadFile>(
  files: ArrayLike<TFile> | null | undefined,
): SkillUploadSelection<TFile> {
  if (!files || files.length === 0) {
    return { file: null, error: null };
  }
  if (files.length !== 1) {
    return { file: null, error: SKILL_UPLOAD_SINGLE_FILE_ERROR };
  }

  const file = files[0];
  if (!file) {
    return { file: null, error: null };
  }

  const hasZipExtension = file.name.trim().toLowerCase().endsWith('.zip');
  const hasZipMimeType = ZIP_MIME_TYPES.has(file.type.trim().toLowerCase());
  if (!hasZipExtension && !hasZipMimeType) {
    return { file: null, error: SKILL_UPLOAD_ZIP_ONLY_ERROR };
  }

  return { file, error: null };
}
