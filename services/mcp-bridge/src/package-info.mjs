import { readFileSync } from "node:fs";

const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export const PACKAGE_NAME = metadata.name;
export const PACKAGE_VERSION = metadata.version;
export const INSTALL_URL = "https://chromewebstore.google.com/detail/dknbdgkgoinlgjpfebapkklbmjjgdblm";
