# Busca de ADs da EASA

Site estático (HTML, CSS e JavaScript, sem login e sem banco de dados) para buscar Diretrizes de
Aeronavegabilidade da EASA por número, modelo, fabricante, componente ou assunto.

```
index.html          página da busca
styles.css          visual (tema claro/escuro)
app.js              busca e resultados
admin.html          painel do administrador (indicadores de uso)
admin.css / admin.js   visual e gráficos do painel
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
4. Senha do painel: engrenagem **Configurações do projeto > Propriedades do script > Adicionar**:
   `ADMIN_SENHA` = uma senha forte. Na primeira busca o script cria no seu Drive a planilha
   **"Busca de ADs EASA - uso"** (o Google pede a permissão das Planilhas).
5. Opcional: no editor, escolha a função `instalarHistoricoEasa` e clique em **Executar**. Ela cria
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

## Painel do administrador (`admin.html`)

Abra `https://<seu-domínio>/admin.html` e entre com a senha `ADMIN_SENHA`. O endereço não aparece
no site nem nos buscadores (noindex), mas a proteção é a senha: use uma forte. Depois de 10
senhas erradas o painel bloqueia por 15 minutos.

- **Período:** hoje, 7, 30 ou 90 dias.
- **Indicadores:** buscas (com e sem resultado), sessões, visitantes (e quantos estão online agora),
  acessos à página, documentos abertos, tempo médio por sessão, tempo de resposta do servidor
  (média, mediana e 95%), erros e % de buscas sem resultado.
- **Gráficos:** buscas por dia (por resultado), acessos por dia, horário de uso, tempo de resposta
  por dia, fluxo da sessão, filtros usados, termos mais buscados, ADs mais abertas e últimas buscas.
  Cada gráfico tem "Ver tabela".
- **Dados brutos:** botão "Abrir planilha" (a planilha fica no Drive da conta do Apps Script).

O que é registrado: cada busca (filtros, página, total, tempo, resultado), o acesso à página, o
clique em documento e o tempo na página. Sessão e visitante são códigos aleatórios do navegador:
nenhum dado pessoal (nem IP) é guardado.

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
- Links de documentos só para o próprio site da EASA. Sem cookies; no navegador ficam só o tema e
  dois códigos aleatórios (sessão e visitante) usados nos indicadores.
- Dá para mandar uma busca pronta por link: `?modelo=AS350&fabricante=Safran`.
- Animações de entrada (título palavra por palavra, painel e resultados em cascata, fundo com grade
  e brilhos, seções que aparecem ao rolar, troca de tema em círculo). Quem ativou "reduzir
  movimento" no sistema vê a página sem animação.

Ferramenta de apoio: não substitui a verificação no site da EASA.
