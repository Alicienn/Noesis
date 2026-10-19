/** Manual check of fetch_url anchors on a long RFC (txt and html). Usage: npx tsx scripts/check-fetch.ts */
import { fetchDocument } from '../server/services/fetch.ts'
import { locateFragment } from '../server/tools/builtin/research.ts'

for (const url of ['https://www.rfc-editor.org/rfc/rfc9000.txt', 'https://www.rfc-editor.org/rfc/rfc9000']) {
  const doc = await fetchDocument(url)
  const at = locateFragment(doc.text, 'section-17.3')
  console.log(`\n${url} → ${doc.contentType} ${doc.text.length} chars, #section-17.3 at ${at}`)
  if (at >= 0) console.log(doc.text.slice(at, at + 160).replace(/\n/g, ' ⏎ '))
  for (const m of [...doc.text.matchAll(/17\.3/g)].slice(0, 4)) console.log('  17.3 ctx:', JSON.stringify(doc.text.slice((m.index ?? 0) - 40, (m.index ?? 0) + 60)))
}
process.exit(0)
