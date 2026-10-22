/** The build supplies a separately typechecked DOM module; Background never imports its globals. */
declare const ELEMENT_PAGE_SCRIPT_SOURCE: string;
export function elementPageFunction(name: 'bounds'): string {
  return `function() { ${ELEMENT_PAGE_SCRIPT_SOURCE}\nreturn QZ_ELEMENT_PAGE_SCRIPTS.${name}(this); }`;
}
