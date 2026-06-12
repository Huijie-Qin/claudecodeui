interface CommandInsertionResult {
  value: string;
  cursorPosition: number;
}

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
