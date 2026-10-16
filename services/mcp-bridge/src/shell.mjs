/** Generated commands target POSIX shells, or PowerShell 7.3+ on Windows. */
export function defaultShell(platform = process.platform) {
  return platform === "win32" ? "powershell" : "posix";
}

export function shellQuote(value, shell = defaultShell()) {
  const text = String(value);
  if (shell === "powershell") {
    // PowerShell recognizes ASCII and curly apostrophes as string delimiters.
    return `'${text.replace(/['\u2018-\u201b]/gu, character => character + character)}'`;
  }
  if (shell !== "posix") throw new TypeError(`Unsupported command shell: ${shell}`);
  return `'${text.replaceAll("'", "'\"'\"'")}'`;
}

export function shellArgument(value, shell = defaultShell()) {
  const text = String(value);
  return /^[A-Za-z0-9_.:-]+$/.test(text) && !(shell === "powershell" && text.startsWith("-")) ? text : shellQuote(text, shell);
}

/** npm's qz.ps1 must pass the terminator through to Node's argument parser. */
export function optionTerminator(shell = defaultShell()) {
  return shell === "powershell" ? "'--'" : "--";
}
