/** Document processing is a background operation; shared DTOs remain independent of engines. */
export { downloadBytes } from "../../background/services/file-download.js";
export { createDocumentBytes, inferDocumentFormat, mimeTypeForFormat, parseDocumentBytes } from "../../shared/documents/document-codecs.js";
export { DOCUMENT_BLOCK_EXAMPLES, DOCUMENT_BLOCK_INPUT_SCHEMA, DOCUMENT_CREATE_CONTENT_INPUT_SCHEMA, DOCUMENT_OUTPUT_FORMATS, DOCUMENT_SHEET_INPUT_SCHEMA, summarizeDocumentContent, validateDirectDocumentCreateInput } from "../../shared/documents/document-create-input.js";
