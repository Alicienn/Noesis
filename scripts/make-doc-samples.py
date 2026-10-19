"""Sample documents (docx, pptx, xlsx, odt, epub, html, ipynb, pdf, png, cp1252 text…) for scripts/e2e-documents.ts."""
import json, os, sys, zipfile, struct, zlib
out = sys.argv[1] if len(sys.argv) > 1 else 'data-test-samples'
os.makedirs(out, exist_ok=True)
os.makedirs(os.path.join(out, 'dossier', 'sous-dossier'), exist_ok=True)

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
doc = f'''<?xml version="1.0"?><w:document {W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Seuil du code de surface</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Le seuil vaut environ </w:t></w:r><w:r><w:t>1 %</w:t></w:r><w:r><w:tab/><w:t>(bruit circuit).</w:t></w:r></w:p>
<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>HYPERLINK "http://x"</w:instrText></w:r><w:r><w:t>lien visible</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>distance</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>taux</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>5</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>0,3 &amp; plus</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>'''
core = '<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Note interne sur les codes</dc:title><dc:creator>Alice Martin</dc:creator></cp:coreProperties>'
with zipfile.ZipFile(os.path.join(out, 'note.docx'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', '<Types/>')
    z.writestr('word/document.xml', doc)
    z.writestr('docProps/core.xml', core)

with zipfile.ZipFile(os.path.join(out, 'slides.pptx'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('ppt/presentation.xml', '<p:presentation/>')
    for i, t in [(1, 'Introduction'), (2, 'Résultats clés'), (10, 'Conclusion')]:
        z.writestr(f'ppt/slides/slide{i}.xml', f'<p:sld><a:p><a:r><a:t>{t}</a:t></a:r></a:p><a:p><a:r><a:t>Point {i}</a:t></a:r></a:p></p:sld>')
    z.writestr('ppt/notesSlides/notesSlide2.xml', '<p:notes><a:p><a:r><a:t>Dire que le seuil est robuste</a:t></a:r></a:p></p:notes>')

with zipfile.ZipFile(os.path.join(out, 'mesures.xlsx'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('xl/workbook.xml', '<workbook><sheets><sheet name="Mesures" sheetId="1"/><sheet name="Params" sheetId="2"/></sheets></workbook>')
    z.writestr('xl/sharedStrings.xml', '<sst><si><t>distance</t></si><si><t>erreur logique</t></si><si><r><t>p</t></r></si></sst>')
    z.writestr('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>3</v></c><c r="B2"><v>0.012</v></c></row></sheetData></worksheet>')
    z.writestr('xl/worksheets/sheet2.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>2</v></c><c r="B1"><v>0.001</v></c></row></sheetData></worksheet>')

with zipfile.ZipFile(os.path.join(out, 'rapport.odt'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('mimetype', 'application/vnd.oasis.opendocument.text')
    z.writestr('content.xml', '<office:document-content><office:body><office:text><text:h text:outline-level="1">Titre ODT</text:h><text:p>Paragraphe avec<text:tab/>tab.</text:p></office:text></office:body></office:document-content>')
    z.writestr('meta.xml', '<office:document-meta><office:meta><dc:title>Rapport ODT</dc:title></office:meta></office:document-meta>')

with zipfile.ZipFile(os.path.join(out, 'livre.epub'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('mimetype', 'application/epub+zip')
    z.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>')
    z.writestr('OEBPS/content.opf', '<package><metadata><dc:title>Livre test</dc:title><dc:creator>Bob</dc:creator></metadata><manifest><item id="c1" href="ch1.xhtml"/><item id="c2" href="ch2.xhtml"/></manifest><spine><itemref idref="c2"/><itemref idref="c1"/></spine></package>')
    z.writestr('OEBPS/ch1.xhtml', '<html><body><h1>Chapitre un</h1><p>Texte du premier chapitre, assez long pour Readability peut-être.</p></body></html>')
    z.writestr('OEBPS/ch2.xhtml', '<html><body><h1>Chapitre deux</h1><p>Deuxième chapitre en premier dans la spine.</p></body></html>')

open(os.path.join(out, 'notes.md'), 'w', encoding='utf8').write('# Mes notes de départ\n\nIl faut comparer MWPM et Union-Find.\n')
open(os.path.join(out, 'data.csv'), 'w', encoding='utf8').write('d,p,pl\n3,0.001,0.0002\n5,0.001,0.00001\n')
open(os.path.join(out, 'page.html'), 'w', encoding='utf8').write('<html><head><title>Page sauvegardée</title></head><body><nav>menu</nav><article><h1>Article</h1><p>Contenu principal de la page HTML sauvegardée, avec suffisamment de texte pour être retenu.</p></article></body></html>')
open(os.path.join(out, 'calc.ipynb'), 'w', encoding='utf8').write(json.dumps({'cells': [{'cell_type': 'markdown', 'source': ['# Calcul']}, {'cell_type': 'code', 'source': ['print(1+1)'], 'outputs': [{'text': ['2\n']}]}], 'metadata': {'kernelspec': {'language': 'python'}}}))
open(os.path.join(out, 'latin1.txt'), 'wb').write('Résumé élégant à côté — façon Windows '.encode('cp1252') * 40)
open(os.path.join(out, 'dossier', 'a.tex'), 'w', encoding='utf8').write('\\title{Article LaTeX}\\begin{document}Théorème.\\end{document}')
open(os.path.join(out, 'dossier', 'sous-dossier', 'b.py'), 'w', encoding='utf8').write('def f(x):\n    return x * 2\n')

# PNG 1x1
def png():
    raw = b'\x00\xff\x00\x00'
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
open(os.path.join(out, 'figure.png'), 'wb').write(png())

# minimal 2-page PDF
def pdf(pages):
    objs = []
    kids = ' '.join(f'{3 + 2 * i} 0 R' for i in range(len(pages)))
    objs.append('<< /Type /Catalog /Pages 2 0 R >>')
    objs.append(f'<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>')
    font = 3 + 2 * len(pages)
    for i, t in enumerate(pages):
        content = f'BT /F1 18 Tf 72 720 Td ({t}) Tj ET'
        objs.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font} 0 R >> >> /Contents {4 + 2 * i} 0 R >>')
        objs.append(f'<< /Length {len(content)} >>\nstream\n{content}\nendstream')
    objs.append('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    body = '%PDF-1.4\n'
    offsets = []
    for n, o in enumerate(objs, 1):
        offsets.append(len(body))
        body += f'{n} 0 obj\n{o}\nendobj\n'
    xref = len(body)
    body += f'xref\n0 {len(objs) + 1}\n0000000000 65535 f \n' + ''.join(f'{o:010d} 00000 n \n' for o in offsets)
    body += f'trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF'
    return body.encode('latin1')
open(os.path.join(out, 'article.pdf'), 'wb').write(pdf(['Page one about thresholds', 'Page two with decoders']))
open(os.path.join(out, 'vide.txt'), 'w').write('')
print('samples in', out)
