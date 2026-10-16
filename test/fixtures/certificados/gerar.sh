#!/bin/sh
# Certificados de TESTE do Scanner Doc, com dados fictícios e sem valor nenhum (não são da ICP-Brasil).
# Nunca coloque um certificado real nesta pasta nem nos testes.
#
# Cadeia como a da ICP-Brasil: AC raiz → AC intermediária → titular ("PESSOA DE TESTE", CPF fictício).
# O certificado do titular segue o formato do e-CPF A1 (DOC-ICP-04): várias OU no nome, "NOME:CPF" no CN, os dados
# da pessoa física no subjectAltName (OID 2.16.76.1.3.1: nascimento, CPF, NIS, RG e órgão expedidor, todos
# fictícios), política de certificado no ramo da ICP-Brasil (2.16.76.1.2.1, com um número que não existe) e
# endereços de LCR e da cadeia num domínio que não existe (.invalid).
# Um segundo titular ("SEGUNDA PESSOA DE TESTE") assina depois do primeiro, nos testes de coassinatura.
# Senha de todos os .pfx: senha-de-teste
#
# Uso, nesta pasta, com o OpenSSL 3 (o provedor "legacy" gera os .pfx no formato antigo, com RC2 e 3DES):
#   sh gerar.sh
# Cada execução cria chaves novas; os testes não dependem de nenhum valor fixo dos certificados.
set -eu
export MSYS_NO_PATHCONV=1 # Git Bash no Windows: não transformar "/CN=..." em caminho de arquivo
SENHA=senha-de-teste
tmp=$(mktemp -d ./tmp.XXXXXX) # caminho relativo: funciona também com o OpenSSL do Windows
trap 'rm -rf "$tmp"' EXIT

# Os dados do titular vêm do ambiente ($ENV::), para o mesmo perfil servir aos dois titulares.
cat > "$tmp/ext.cnf" <<'EOF'
[ac]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
[titular]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, nonRepudiation, keyEncipherment
extendedKeyUsage = clientAuth, emailProtection
authorityKeyIdentifier = keyid
certificatePolicies = 2.16.76.1.2.1.999
subjectAltName = otherName:2.16.76.1.3.1;OCTETSTRING:$ENV::DADOS_PF, otherName:2.16.76.1.3.6;OCTETSTRING:000000000000, email:$ENV::EMAIL
crlDistributionPoints = URI:http://ac.exemplo.invalid/lcr-ac-de-teste.crl
authorityInfoAccess = caIssuers;URI:http://ac.exemplo.invalid/cadeia-ac-de-teste.p7b
[sem_assinatura]
basicConstraints = critical, CA:FALSE
keyUsage = critical, keyEncipherment
authorityKeyIdentifier = keyid
EOF

O="/C=BR/O=Teste sem valor/OU=Certificado de teste"
# Nome do titular como no e-CPF: AC emissora, CNPJ da AR, tipo de validação e tipo de certificado.
TITULAR_OU="/C=BR/O=Teste sem valor/OU=AC DE TESTE/OU=00000000000000/OU=Videoconferencia/OU=Certificado PF A1"

# Titular atual: CN ("NOME:CPF"), dados da pessoa física (8 dígitos do nascimento, 11 do CPF, 11 do NIS, 15 do RG
# e 10 do órgão expedidor com a UF) e e-mail. Definidos antes das AC: o OpenSSL lê o ext.cnf inteiro toda vez.
export NOME="PESSOA DE TESTE" CPF=00000000191 EMAIL=pessoa.de.teste@exemplo.invalid
export DADOS_PF="01011990${CPF}000000000000000000000000000000000000"

# AC raiz (autoassinada) e AC intermediária.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/raiz.key" -out "$tmp/raiz.crt" -days 9000 \
  -subj "$O/CN=AC RAIZ DE TESTE" -config /dev/null -extensions raiz -extfile "$tmp/ext.cnf" 2>/dev/null \
  || openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/raiz.key" -out "$tmp/raiz.crt" -days 9000 \
  -subj "$O/CN=AC RAIZ DE TESTE" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl req -newkey rsa:2048 -nodes -keyout "$tmp/ac.key" -out "$tmp/ac.csr" -subj "$O/CN=AC DE TESTE"
openssl x509 -req -in "$tmp/ac.csr" -CA "$tmp/raiz.crt" -CAkey "$tmp/raiz.key" -out "$tmp/ac.crt" -days 8000 \
  -extfile "$tmp/ext.cnf" -extensions ac
cat "$tmp/ac.crt" "$tmp/raiz.crt" > "$tmp/cadeia.pem"

# titular <nome> <extensões> <tipo de chave> [opções de data do x509]
titular() {
  nome=$1; ext=$2; chave=$3; shift 3
  openssl req -newkey "$chave" -nodes -keyout "$tmp/$nome.key" -out "$tmp/$nome.csr" \
    -subj "$TITULAR_OU/CN=$NOME:$CPF"
  openssl x509 -req -in "$tmp/$nome.csr" -CA "$tmp/ac.crt" -CAkey "$tmp/ac.key" -out "$tmp/$nome.crt" \
    -extfile "$tmp/ext.cnf" -extensions "$ext" "$@"
}

titular titular titular rsa:2048 -days 7000
titular vencido titular rsa:2048 -not_before 20200101000000Z -not_after 20210101000000Z
titular sem-assinatura sem_assinatura rsa:2048 -days 7000
titular chave-1024 titular rsa:1024 -days 7000
openssl ecparam -name prime256v1 -out "$tmp/ec.pem"
titular ec titular "ec:$tmp/ec.pem" -days 7000

pfx() {
  saida=$1; nome=$2; shift 2
  openssl pkcs12 -export -inkey "$tmp/$nome.key" -in "$tmp/$nome.crt" -name "$NOME" \
    -passout "pass:$SENHA" -out "$saida" "$@"
}

# Padrão do OpenSSL 3: PBES2 (PBKDF2 com SHA-256 e AES-256-CBC), MAC com SHA-256.
pfx titular-aes.pfx titular -certfile "$tmp/cadeia.pem"
# Como sai do Windows e de certificadoras mais antigas: certificados com RC2 de 40 bits, chave com 3DES, MAC SHA-1.
pfx titular-legacy.pfx titular -certfile "$tmp/cadeia.pem" -legacy
# Exportação "TripleDES-SHA1" do Windows: tudo com 3DES.
pfx titular-3des.pfx titular -certfile "$tmp/cadeia.pem" -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1
# Só o certificado do titular, sem a cadeia.
pfx titular-sem-cadeia.pfx titular
pfx vencido.pfx vencido -certfile "$tmp/cadeia.pem"
pfx sem-assinatura.pfx sem-assinatura -certfile "$tmp/cadeia.pem"
pfx chave-1024.pfx chave-1024 -certfile "$tmp/cadeia.pem"
pfx ec.pfx ec -certfile "$tmp/cadeia.pem"

# Segundo titular, da mesma AC: assina depois do primeiro (coassinatura).
export NOME="SEGUNDA PESSOA DE TESTE" CPF=00000000272 EMAIL=segunda.pessoa.de.teste@exemplo.invalid
export DADOS_PF="02021985${CPF}000000000000000000000000000000000000"
titular segundo titular rsa:2048 -days 7000
pfx segundo-titular.pfx segundo -certfile "$tmp/cadeia.pem"

# A AC raiz, para os testes conferirem a cadeia.
openssl x509 -in "$tmp/raiz.crt" -outform DER -out ac-raiz.cer
echo "Certificados de teste gerados."
