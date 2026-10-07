export function saveBlobAsFile(blob: Blob, filename: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function getExtension(filename: string) {
  return String(filename).split(".").pop() ?? '';
}
