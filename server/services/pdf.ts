import { extractText, getDocumentProxy } from 'unpdf'

export interface PdfText {
  pages: string[]
  totalPages: number
  title?: string
}

/** Pure-JS PDF text extraction (pdf.js serverless build), page by page. */
export async function pdfToText(buffer: Uint8Array): Promise<PdfText> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0 } as any)
  const { totalPages, text } = await extractText(pdf, { mergePages: false })
  let title: string | undefined
  try {
    const meta = await pdf.getMetadata()
    const t = (meta?.info as Record<string, unknown> | undefined)?.Title
    if (typeof t === 'string' && t.trim().length > 3) title = t.trim()
  } catch {
    // ignore
  }
  const pages = (Array.isArray(text) ? text : [text]).map(p => cleanPdfText(p))
  return { pages, totalPages, title }
}

function cleanPdfText(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .replace(/-\n(?=[a-zà-ÿ])/g, '') // de-hyphenate line breaks
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function isPdf(buffer: Uint8Array): boolean {
  return buffer.length > 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46
}
