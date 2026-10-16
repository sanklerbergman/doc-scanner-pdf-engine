#!/bin/sh
# Certificados de TESTE do Scanner Doc, com dados fictícios e sem valor nenhum (não são da ICP-Brasil).
# Nunca coloque um certificado real nesta pasta nem nos testes.
#
# Cadeia como a da ICP-Brasil: AC raiz → AC intermediária → titular ("PESSOA DE TESTE", CPF fictício).
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
[sem_assinatura]
basicConstraints = critical, CA:FALSE
keyUsage = critical, keyEncipherment
authorityKeyIdentifier = keyid
EOF

O="/C=BR/O=Teste sem valor/OU=Certificado de teste"

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
    -subj "$O/CN=PESSOA DE TESTE:00000000191"
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
  openssl pkcs12 -export -inkey "$tmp/$nome.key" -in "$tmp/$nome.crt" -name "PESSOA DE TESTE" \
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

# A AC raiz, para os testes conferirem a cadeia.
openssl x509 -in "$tmp/raiz.crt" -outform DER -out ac-raiz.cer
echo "Certificados de teste gerados."
