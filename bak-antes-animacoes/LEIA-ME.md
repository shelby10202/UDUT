# Busca de ADs da EASA

Site estático (HTML, CSS e JavaScript, sem login e sem banco de dados) para buscar Diretrizes de
Aeronavegabilidade da EASA por número, modelo, fabricante, componente ou assunto.

```
index.html          página
styles.css          visual (tema claro/escuro)
app.js              busca e resultados
config.js           URL do servidor da busca  ← preencher
tema-inicial.js     aplica o tema salvo antes de a página aparecer
favicon.svg         ícone
apps-script/Codigo.gs   servidor da busca (Google Apps Script) — NÃO vai para a hospedagem
```

## 1. Publicar o servidor da busca (uma vez)

O navegador não consegue ler o site da EASA diretamente (bloqueio CORS), então a busca roda num
App da Web do Google Apps Script, que é gratuito.

1. Abra script.google.com > **Novo projeto**, apague o conteúdo e cole `apps-script/Codigo.gs`. Salve.
2. **Implantar > Nova implantação** > tipo **App da Web**:
   - Executar como: **Eu**
   - Quem pode acessar: **Qualquer pessoa**
3. Autorize quando pedir (acesso a serviço externo e ao Google Drive, onde fica uma cópia de reserva
   dos dados) e copie a URL que termina em `/exec`.
4. Opcional: no editor, escolha a função `instalarHistoricoEasa` e clique em **Executar**. Ela cria
   um gatilho de hora em hora que mantém os dados prontos, para a busca não esperar o download da EASA.

Para conferir, abra `<URL>/exec?acao=status` no navegador: deve aparecer `"servico":"busca-ad-easa"`.

Ao mudar o `Codigo.gs` depois: **Implantar > Gerenciar implantações > Editar (lápis) > Versão:
Nova versão > Implantar**. Assim a URL continua a mesma.

## 2. Configurar e hospedar o site

1. Cole a URL `/exec` em `config.js`:
   ```js
   export const APPS_SCRIPT_URL = "https://script.google.com/macros/s/…/exec";
   ```
2. Suba os arquivos da pasta (menos `apps-script/` e este LEIA-ME) em qualquer hospedagem de site
   estático: Firebase Hosting, Netlify, Cloudflare Pages, GitHub Pages, um servidor web comum etc.
   Não precisa de build.

Se a hospedagem tiver Content-Security-Policy, libere o servidor da busca:

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
connect-src 'self' https://script.google.com https://script.googleusercontent.com;
base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

## Como a busca funciona

- Junta o **arquivo histórico** da EASA (conjunto de dados oficial, ADs desde 2003) com a **página
  provisória** de publicações recentes, sem repetir número. Se o mesmo número está nas duas, vale a
  data de emissão mais nova.
- Entram só ADs com numeração da EASA (AAAA-NNNN, com R1, -E, -CN), classes AD, EAD e ADR. Propostas
  (PAD) ficam de fora.
- Filtros sem diferença de acento, espaço ou pontuação, todos juntos (E), por trecho. O campo
  "Fabricante, componente ou assunto" procura no detentor da aprovação e no assunto da AD.
- Os dados são lidos de novo a cada hora. Se a EASA não responder, vale a última leitura guardada e
  a página avisa.
- Links de documentos só para o próprio site da EASA. A página não grava nada nem usa cookies; só o
  tema escolhido fica salvo no navegador.
- Dá para mandar uma busca pronta por link: `?modelo=AS350&fabricante=Safran`.

Ferramenta de apoio: não substitui a verificação no site da EASA.
