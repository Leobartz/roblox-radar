# 🐸 Papanoobhy Radar

Seu próprio "Creator Exchange": um site que coleta dados públicos do Roblox a cada 15 minutos
e mostra os jogos mais jogados, os que estão subindo, as promessas, os estáveis e os seus jogos,
com gráficos de histórico. Roda de graça no GitHub (Actions + Pages), sem servidor, sem cartão.

## Como colocar no ar (uns 10 minutos, só clicando)

1. **Crie uma conta no GitHub** (github.com) se ainda não tiver.
2. **Crie um repositório novo**: botão "New repository" → nome `roblox-radar` → deixe **Public**
   (repositórios públicos têm minutos ilimitados de Actions; privados têm limite e o radar pode parar
   no fim do mês) → "Create repository".
3. **Suba os arquivos**: na página do repositório, clique em "uploading an existing file",
   arraste **todo o conteúdo** desta pasta (as pastas `.github`, `collector`, `config`, `site` e este README)
   e clique em "Commit changes".
   > Dica: se o seu explorador de arquivos esconder a pasta `.github`, ative "itens ocultos".
   > Sem ela o robô não roda!
4. **Ligue o Actions**: aba **Actions** → se aparecer um botão verde "I understand my workflows, go ahead and enable them", clique.
5. **Ligue o Pages**: aba **Settings → Pages** → em "Source" escolha **GitHub Actions**. (O robô tenta
   fazer isso sozinho na primeira rodada; se já estiver marcado, ótimo.)
6. **Rode a primeira vez**: aba **Actions** → "Radar - coletar dados e publicar site" → botão **Run workflow**.
   Em uns 2 minutos o site aparece em `https://SEU-USUARIO.github.io/roblox-radar/`.

A partir daí ele roda sozinho a cada 15 minutos. Os rankings do momento já funcionam na primeira rodada;
as colunas de crescimento aparecem depois de 24–48h de histórico, e as de 7 dias depois de 2 semanas.

O sinal **Explodindo** começa a calibrar depois de cerca de 2 horas. Ele exige pelo menos 10% e
500 jogadores de alta em 1 hora, com crescimento persistente, e combina aceleração, participação
de mercado, avanço nas prateleiras e aprovação. **Novos no radar** mostra entradas e reentradas nas
prateleiras monitoradas depois da calibração inicial.

## Acompanhar os seus jogos

Edite `config/my_games.json` (no GitHub mesmo: clique no arquivo → lápis ✏️ → Commit):

```json
{
  "jogos": ["https://www.roblox.com/games/123456789/Hungry-Floppas", 987654321],
  "usuarios": [111111],
  "grupos": [2222222]
}
```

- `jogos`: links ou IDs dos jogos (placeId). Pode misturar.
- `usuarios`: IDs de usuário — todos os jogos públicos da pessoa entram.
- `grupos`: IDs de grupo — todos os jogos públicos do grupo entram (ex.: o grupo Papanoobhy).

O ID do usuário/grupo está na URL do perfil: `roblox.com/users/111111/profile` → `111111`.

## Como funciona (pra curiosos)

- `collector/collect.mjs` — o robô. Pergunta ao Roblox quais jogos estão nas prateleiras
  ("Mais jogados", "Em ascensão", "Tendência", "Mais revisitados", "Com amigos") em computador,
  celular e console, pega detalhes de cada um (online, visitas, favoritos, likes, data de criação)
  e guarda o histórico.
- `.github/workflows/radar.yml` — o despertador. Roda o robô a cada 15 minutos, guarda os dados numa
  branch chamada `data` (sempre substituída, pra não inchar o repositório) e publica o site.
- `site/index.html` — o site. Lê os JSONs e monta rankings e gráficos. Tudo em um arquivo só.
- Histórico: a cada 15 minutos nos últimos 14 dias; depois disso, um resumo por dia (pico, média, visitas) pra sempre.

### O que o Roblox NÃO conta pra ninguém
Receita (Robux) e tempo de jogo de jogos dos outros não são públicos. Sites como o Creator Exchange
mostram *estimativas*. Aqui a gente mostra só dados reais — e o crescimento é calculado a partir deles.

## Problemas comuns

- **O site abre mas diz "erro ao carregar dados"**: a primeira rodada ainda não terminou, ou o Pages
  não está em "GitHub Actions" (passo 5).
- **Parou de atualizar depois de 2 meses**: o GitHub desliga agendamentos de repositórios sem atividade
  por 60 dias. Basta entrar em Actions e clicar "Run workflow" (ou editar qualquer arquivo) que ele volta.
- **Quer rodar no seu PC**: instale o Node.js 20+, abra o terminal na pasta e rode
  `node collector/collect.mjs` (ou `--mock` pra dados de teste) e depois abra `site/index.html` com um
  servidor local (ex.: `npx serve _site`).
