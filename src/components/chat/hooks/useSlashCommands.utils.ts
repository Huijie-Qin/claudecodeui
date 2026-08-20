interface CommandInsertionResult {
  value: string;
  cursorPosition: number;
}

interface SlashCommandArguments {
  args: string[];
  rawArgs: string;
}

interface SkillSlashCommandLike {
  namespace?: unknown;
  metadata?: {
    type?: unknown;
  } | null;
}

export const getLeadingSlashCommandName = (input: string): string | null => {
  const match = input.match(/^\s*(\/\S+)(?=\s|$)/);
  return match?.[1] || null;
};

export const isSkillSlashCommand = (command: SkillSlashCommandLike | null | undefined): boolean => {
  if (!command) {
    return false;
  }

  const namespace = String(command.namespace || '');
  return command.metadata?.type === 'skill' || namespace.includes('skill');
};

export const shouldExpandSlashCommand = (command: SkillSlashCommandLike | null | undefined): boolean => {
  return Boolean(command && !isSkillSlashCommand(command));
};

export const extractSlashCommandArguments = ({
  commandName,
  input,
}: {
  commandName: string;
  input: string;
}): SlashCommandArguments => {
  const normalizedInput = input.trimStart();
  if (!normalizedInput.startsWith(commandName)) {
    return { args: [], rawArgs: '' };
  }

  const remainder = normalizedInput.slice(commandName.length);
  if (remainder && !/^\s/.test(remainder)) {
    return { args: [], rawArgs: '' };
  }

  const rawArgs = remainder.trim();
  return {
    args: rawArgs ? rawArgs.split(/\s+/) : [],
    rawArgs,
  };
};

export const buildInputWithSelectedSlashCommand = ({
  commandName,
  cursorPosition,
  input,
  replacementEndPosition,
  slashPosition,
}: {
  commandName: string;
  cursorPosition?: number;
  input: string;
  replacementEndPosition?: number;
  slashPosition: number;
}): CommandInsertionResult => {
  if (slashPosition >= 0) {
    const replacementEnd = Math.min(
      input.length,
      Math.max(slashPosition + 1, replacementEndPosition ?? cursorPosition ?? slashPosition + 1),
    );
    const textBeforeSlash = input.slice(0, slashPosition);
    const textAfterQuery = input.slice(replacementEnd);
    const separator = textAfterQuery && /^\s/.test(textAfterQuery) ? '' : ' ';
    const cursorOffset = separator ? separator.length : 1;

    return {
      value: `${textBeforeSlash}${commandName}${separator}${textAfterQuery}`,
      cursorPosition: textBeforeSlash.length + commandName.length + cursorOffset,
    };
  }

  const insertionPosition = Math.min(input.length, Math.max(0, cursorPosition ?? input.length));
  const textBeforeCursor = input.slice(0, insertionPosition);
  const textAfterCursor = input.slice(insertionPosition);
  const leadingSpace = textBeforeCursor && !/\s$/.test(textBeforeCursor) ? ' ' : '';
  const commandSuffix = textAfterCursor && /^\s/.test(textAfterCursor) ? '' : ' ';

  return {
    value: `${textBeforeCursor}${leadingSpace}${commandName}${commandSuffix}${textAfterCursor}`,
    cursorPosition:
      textBeforeCursor.length +
      leadingSpace.length +
      commandName.length +
      (commandSuffix ? commandSuffix.length : 1),
  };
};
