# PDF Printer (label sheets)

Upload marketplace PDFs, get one four-up label sheet back in a new tab.

## How it works

`src/lib/label-print/` is pure PDF processing with no database access:

1. `extract.ts` reads each page's text layer (pdfjs).
2. `classify.ts` decides, from page **content only** (never file names or page
   position), whether a page is a label, an invoice, or unrecognised, and reads
   the order id and product lines (name / size / colour) from the invoice.
   - Amazon: the label is a picture with no text, so a text-less page is a
     label, paired with the invoice beside it. Invoices can run to two pages, so
     labels are never assumed to be "every other page".
   - Meesho: label and invoice share one page; the whole page is kept.
3. `clean.ts` erases the thick black frame baked into some Amazon carriers'
   label pictures (detected by shape, not carrier).
4. `compose.ts` places four pages per A4 sheet in exact quarters (no margin,
   so an A4 source lands at exactly 50%, an A6), then stamps the product.
   `STAMP_BOX` holds the per-platform stamp position and font size.

`src/app/api/label-print/` stores each result in `label_print_runs` (the PDF
itself plus a per-label log, kept permanently) and serves it inline.

## Limits

- Vercel caps request bodies at 4.5 MB (about 80 Amazon labels per run). The
  route rejects anything larger. If volume grows, upload files to storage
  first and process from there.

## TODO

- **Flipkart**: no sample PDF yet, so Flipkart pages currently show up as
  "unrecognised" in the run report. Once a sample exists: add a detector and
  product parser in `classify.ts`, and a `flipkart` entry in `STAMP_BOX`.
- **Product stamp**: the Meesho stamp position and the Amazon stamp position
  are first guesses; adjust `STAMP_BOX` after checking a print.
