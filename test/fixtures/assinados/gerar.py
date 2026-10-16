# PDFs assinados por OUTRO programa (o pyHanko), para os testes de coassinatura e de PDF certificado.
# A assinatura é feita com o certificado de TESTE de ../certificados (dados fictícios, sem valor nenhum).
# Nunca use um certificado real aqui.
#
# - assinado.pdf: uma assinatura comum (PAdES), com tabela xref clássica;
# - certificado-p1.pdf: certificado pelo autor sem permitir nenhuma alteração (/DocMDP com /P 1);
# - certificado-p2.pdf: certificado permitindo preencher formulários e assinar (/P 2), com a tabela xref em
#   stream e os objetos em object streams.
#
# Uso, nesta pasta, com o pyHanko e o pikepdf instalados (pip install pyhanko pikepdf):
#   python gerar.py
# Cada execução gera assinaturas novas; os testes não dependem de nenhum valor fixo.
import io

import pikepdf
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import fields, signers

PFX = '../certificados/titular-aes.pfx'
SENHA = b'senha-de-teste'


def base(object_streams):
    pdf = pikepdf.new()
    content = b'BT /F1 14 Tf 72 760 Td (Contrato de teste, assinado por outro programa) Tj ET'
    font = pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica)
    for _ in range(2):
        page = pikepdf.Dictionary(Type=pikepdf.Name.Page, MediaBox=[0, 0, 595, 842],
                                  Resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font)),
                                  Contents=pdf.make_stream(content))
        pdf.pages.append(pikepdf.Page(page))
    out = io.BytesIO()
    mode = pikepdf.ObjectStreamMode.generate if object_streams else pikepdf.ObjectStreamMode.disable
    pdf.save(out, object_stream_mode=mode, static_id=True)
    return out.getvalue()


def sign(source, output, **meta):
    signer = signers.SimpleSigner.load_pkcs12(PFX, passphrase=SENHA)
    writer = IncrementalPdfFileWriter(io.BytesIO(source))
    metadata = signers.PdfSignatureMetadata(field_name='Autor', subfilter=fields.SigSeedSubFilter.PADES, **meta)
    with open(output, 'wb') as out:
        signers.sign_pdf(writer, metadata, signer=signer, output=out)


sign(base(False), 'assinado.pdf')
sign(base(False), 'certificado-p1.pdf', certify=True, docmdp_permissions=fields.MDPPerm.NO_CHANGES)
sign(base(True), 'certificado-p2.pdf', certify=True, docmdp_permissions=fields.MDPPerm.FILL_FORMS)
print('PDFs assinados de teste gerados.')
