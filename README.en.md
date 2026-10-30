# Scanner Doc

[Português](README.md) · **English**

Photo, Word or PDF: everything becomes a PDF, **100% in the browser**. No upload, no sign-up, no tracking.
Made by the community, for the community.

**Use it now: https://scanner.sankler.com.br/en/** (in Portuguese: https://scanner.sankler.com.br/)

## What it does

- Take photos with the phone camera, with a **light button**, a low-light warning and a live outline of the paper, or pick several images (drag and drop and paste also work)
- **Automatic paper crop** with perspective and aspect-ratio correction, adjustable by dragging the corners, with a magnifier to place the edge of the paper your finger is covering
- View each page in full screen, exactly as it will look in the PDF, and **copy its text** (photo, scanned PDF, PDF with text or Word; anything under a redaction is not copied)
- Reorder (by dragging the card's handle or with the buttons), rotate and remove pages
- Filters: **Document** (removes shadows, whitens the background, strengthens faint text), **Enhanced color**, **Black and white** and **Original**
- A4, Letter or same-as-image page size; adjustable margin and quality
- Download or share the PDF (on the phone)
- Opens **Word documents (.docx)**: the PDF comes out with real text (selectable and searchable), with headings, lists, bold and italics, tables, images, header and footer (with "Page X of Y"), in the document's page size and margins. Pages can be mixed with photos
- **PDF/A** (PDF/A-2b, the archiving format some courts require for electronic filings): for photos and Word documents, with or without searchable text and the signature (with the visible stamp, if you want). For Word pages and the stamp, the fonts are embedded in the PDF (the Liberation fonts, with the same metrics as Helvetica, Times and Courier, with only the letters used). It does not apply to pages from another PDF and does not combine with a password, because PDF/A does not allow encryption
- **Edits the pages** (photo, Word or PDF page): in full screen, "Edit" adds text, freehand drawing, an image (PNG with a transparent background or JPEG), rectangle, arrow, ✓ and ✗, highlight, underline and strikethrough, by finger, mouse or keyboard. On all pages at once: page numbers ("1 of 7"), header and footer, watermark ("COPY", "CONFIDENTIAL") and your initials, drawn once. Everything is fixed on the page: whoever receives the PDF cannot remove it. Text that already exists in the PDF is not changed, and redactions go on top of everything
- **Fills in PDF forms** (applications, records, requests): in full screen on a page with fields, "Fill in" shows one field at a time, with the page zoomed in on it and the right keyboard on the phone. Amounts, dates and Brazilian IDs (CNPJ, CPF, CEP) come out in the format the form asks for, without running the PDF's scripts. The values are fixed on the page of the new PDF. Forms filled in another program keep their values. XFA-only forms (for Adobe Reader) are not filled
- **Real redaction**: in a page's full screen, mark what to hide (ID numbers, address, account, signature). What is under the redaction is erased from the PDF, not just covered: in photos, the pixels are painted over; in Word, the text underneath is removed from the page; a redacted page from another PDF becomes an image. Before handing it over, the app reads the new PDF again and checks that no text is left under any redaction. The "Find data to redact" button finds email addresses, phone numbers, card numbers and Brazilian IDs (CPF, CNPJ, CEP) in the text of the pages (in photos and scanned PDFs, with OCR) and suggests redactions, which you confirm one by one
- Opens **password-protected PDFs** (pay slips, statements, bills): the app asks for the password, which is only used on the device and is not kept. PDFs that only have author restrictions open directly. The new PDF has no password, unless you turn on "Protect the PDF with a password"
- **Protects the generated PDF with a password** (AES-256): whoever receives it needs the password to open it. The app does not keep the password and cannot recover it
- **Merges, splits and compresses PDFs**: open one or more PDFs, reorder, remove or mix the pages with photos and documents, and create one PDF, one per page or one per range (e.g. 1-3, 4-10). You can view each page first and check, in a preview, the files that will be created. Pages go in as they are in the original, with selectable text; links, scripts, metadata and the content of hidden layers are left out, and form fields are fixed on the page with whatever was filled in. To shrink PDFs made from scans or photos, the images can be recompressed, with the "before → after" size. It warns you when the PDF has a digital signature, which stops being valid in the new file (to keep it, sign the PDF without changing anything in it)
- **Searchable text (OCR)** in photos and scanned PDFs: printed text is recognized on the device itself and goes into the PDF as an invisible layer over the image, which you can search, select and copy. PDF pages that already have text stay as they are. A crooked sheet (a photo without a background to crop, or a sheet that went through the scanner crooked) is read as straight, up to a 15° tilt, and the app tells you on which pages part of the text may be wrong (shaky, dark photo or small print). Optional and off by default: the first time, the app downloads about 7 MB from the site itself (on the English page, the English model; on the Portuguese page, the Portuguese one, about 5 MB)
- **Signs the PDF with an A1 digital certificate** (Brazilian ICP-Brasil e-CPF or e-CNPJ, a .pfx or .p12 file), in the PAdES standard, which Acrobat recognizes. The certificate, the password and the document do not leave the device and are not kept. A visible stamp ("Digitally signed by", name, date and time) is optional, on the page and in the position you choose, with a preview. An existing PDF, opened and signed without changing anything, gets the signature appended at the end of the file, without being rewritten: the signatures it already had stay valid, and two people can sign the same contract, one after the other. PDFs certified by the author without allowing changes are refused. Tokens, smart cards (A3) and cloud certificates don't work, because they require an installed program or the certificate authority's server
- Opens iPhone **HEIC** photos in any browser (built-in decoder, loaded only when needed)
- In Portuguese and in English: the language is in the address (`/` and `/en/`), and the app keeps nothing on the device to remember it
- Works offline after the first visit

## Privacy (the main point)

| Guarantee | How |
| --- | --- |
| No file leaves the device | All processing happens in the browser (`<canvas>` and a Web Worker). There is no backend. |
| It can't even send | CSP with `connect-src 'none'`: the browser blocks fetch/XHR/WebSocket/beacon in the page and in the Workers, which are the only places the files go through. The service worker (offline cache) has its own policy: it only fetches files from the site itself. |
| Zero third parties | No analytics, cookies, CDN scripts or external fonts. The four libraries (libheif, for HEIC, PDF.js, to show PDF pages, Tesseract, for OCR, and a QR code generator) are served by the site itself and only load when needed, like the PDF/A fonts (Liberation). The digital signature uses no library: the browser itself signs (Web Crypto). |
| Nothing kept | No `localStorage`/IndexedDB. The service worker only caches the app's files. The certificate and the passwords (the certificate's, a protected PDF's and the one chosen to protect the new PDF) only exist in memory while in use; the certificate key enters the browser in a way that cannot be read back. Text recognized by OCR stays in memory only, and "Copy text" only writes to the device's clipboard, when you tap the button. |
| Clean PDF | The photo is redrawn, which discards the EXIF (GPS, phone model, date). From the .docx, metadata (author, company, dates) is not even read. The PDF has no `/Info`, dates or "Producer". From merged PDFs, whatever was in hidden layers does not come along. A signed PDF carries the certificate (with the name and CPF or CNPJ, which is how the recipient checks who signed) and the time of signing; the app tells you first. The exception is signing an existing PDF without changing anything: it stays exactly as it came, with whatever it contains, so earlier signatures stay valid; the app also tells you first. |

You can check it: F12 → **Network** tab while creating a PDF. The only requests are the app's own files and `blob:` URLs (local memory).

### Limits of this guarantee

- The policy arrives in two ways. The `<meta>` in `index.html` applies to the page and the Workers. The headers Cloudflare sends with each file (rules in [`web/_headers`](web/_headers)) repeat this policy and cover what the `<meta>` can't reach: the service worker, which can only fetch files from the site itself, and blocking the site inside another one (iframe).
- Cloudflare, which hosts the site, sees that someone opened the page, as with any site, but never sees the files. After each release, the workflow checks that each live file is identical to the one in the repository, with nothing injected along the way.
- No browser policy prevents the site itself from being changed by whoever controls the repository or the Cloudflare account. The protection against that is open source code, with a public change history, and releases going out only from the `main` branch, after the tests.
- Extensions installed in the browser are outside any page policy: an extension allowed to read sites sees what is on the screen. For sensitive documents, use a browser without extensions or a private window, where they are usually off.
- Whoever hosts a modified copy can change anything, including the Pix key, and may not send the headers. On a fake copy, the digital certificate and password could be stolen: only sign at https://scanner.sankler.com.br/, the official address.
- The OCR text is hidden in the PDF, but it is still there: redacting later in another program covers the image and does not erase the text underneath. To redact, use the app's own redaction (OCR runs on the already redacted photo) or create the PDF without OCR.
- Redaction erases what is in the new PDF, but does not reach copies of the document that already exist (the original file, an email sent earlier).
- The signature is at the basic level (PAdES B-B), with the time from the device's clock: a timestamp and revocation data require a network.

Found a security flaw? See [SECURITY.md](SECURITY.md#english).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (in Portuguese). Golden rule: **no external requests and no tracking.**

## License

[MIT](LICENSE). The four libraries in `web/vendor/` are distributed unchanged and have their own licenses: the HEIC decoder [libheif-js](https://github.com/catdad-experiments/libheif-js) (LGPL-3.0), the PDF renderer [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0), the OCR [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0, with Tesseract's Portuguese and English models) and the QR code generator [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT). The PDF/A fonts, [Liberation](https://github.com/liberationfonts/liberation-fonts), are under the SIL Open Font License 1.1.

---

<p>by <a href="https://sankler.com.br"><picture><source srcset="web/sankler-logo-reduzido-fundo-escuro.svg" media="(prefers-color-scheme: dark)"><img src="web/sankler-logo-reduzido-fundo-claro.svg" alt="Sankler" height="18"></picture></a></p>
