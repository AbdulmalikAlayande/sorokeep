# Soroleep em Português (Brasil)

> Este arquivo é uma tradução para o português brasileiro do [README.md](README.md) original em inglês. O conteúdo técnico (nomes de comandos, blocos de código, flags) permanece em inglês, conforme convenção.

<p align="center">
  <h1 align="center">Sorokeep</h1>
  <p align="center">
    A camada de operações que faltava para contratos inteligentes Soroban implantados.
    <br />
    Monitore TTLs. Receba alertas antes da expiração. Estenda armazenamento automaticamente. Restaure entradas arquivadas.
    <br />
    <br />
    <a href="#instalação">Instalação</a>
    &middot;
    <a href="#início-rápido">Início Rápido</a>
    &middot;
    <a href="#comandos">Comandos</a>
    &middot;
    <a href="#alertas">Alertas</a>
    &middot;
    <a href="#contribuir">Contribuir</a>
  </p>
</p>

<br />

## Por Que Isso Existe

O modelo de armazenamento do Soroban é incomum entre as principais plataformas de contratos inteligentes: **o estado expira.** Cada entrada de ledger — instâncias de contratos, armazenamento persistente, código WASM — possui um Tempo-Para-Viver (TTL). Quando se esgota, a entrada é arquivada. Se a entrada de instância de um contrato expirar, todo o contrato para de funcionar. Se as entradas de armazenamento persistente expirarem, os dados do usuário ficam inacessíveis até que alguém pague para restaurá-los.

Isso é intencional — o arquivamento de estado mantém o Stellar enxuto e escalável. Mas significa que **você deve gerenciar ativamente o ciclo de vida do estado do seu contrato, ou ele morre.**

Atualmente não existe uma ferramenta dedicada de código aberto que combine monitoramento de TTL, alertas, extensão automática, rastreamento de custos e restauração para contratos Soroban. Os desenvolvedores usam comandos CLI manuais, constroem scripts improvisados ou incorporam lógica de extensão de TTL diretamente em seus contratos.

Sorokeep é a camada unificada de operações que cuida de tudo isso.

> Auditores de segurança começaram a sinalizar má gestão de TTL como uma área de risco em contratos Soroban. [Veridise](https://veridise.com/audits/soroban/) inclui tratamento de TTL em seu escopo de auditoria. A [auditoria do endpoint Stellar da LayerZero](https://code4rena.com/audits/2026-04-layerzero-stellar-endpoint) lista explicitamente casos limite de expiração de TTL como uma preocupação. A [biblioteca de contratos Stellar da OpenZeppelin](https://docs.openzeppelin.com/stellar-contracts) deliberadamente deixa o gerenciamento de TTL de armazenamento de instância para o desenvolvedor da aplicação.

## Segurança & SBOM

O Sorokeep gera um Documento de Materiais de Software (SBOM) no formato CycloneDX para cada release. Você pode encontrar o arquivo `bom.json` anexado como um ativo de release na [página de Releases do GitHub](https://github.com/AbdulmalikAlayande/sorokeep/releases).

## Funcionalidades

- **Watch & Introspect** — Registre contratos, descoberta de footprint a partir de transações on-chain e specs de introspecção
- **Monitor** — Polling contínuo de TTL com intervalos configuráveis via daemon de longa duração
- **Alert** — Notificações multi-canal desacopladas e baseadas em fila (Webhook com HMAC-SHA256, Slack Block Kit, Discord, Telegram, PagerDuty) com lógica robusta de retentativa para TTls baixos, picos de uso de recursos e mudanças de estado
- **Auto-Extend** — Extensão automática de TTL baseada em políticas com simulação antes da submissão via `ExtendFootprintTTLOp`
- **Restore** — Recupere entradas arquivadas via transações `RestoreFootprintOp` com simulação pré-submissão
- **Rastreamento de Custos e Recursos** — Acompanhe histórico de extensões, custos em XLM, projeções de 30 dias, logs de uso de recursos e aplique orçamentos mensais configuráveis para evitar gastos descontrolados
- **Inspect** — Inspecione estado on-chain, analise saldos de tokens SAC e compare mudanças de estado
- **Channels** — Gerencie contas de canal financiadas para submissões simultâneas de transações sem gargalos de sequência
- **Local-First** — Todo o estado armazenado em um banco de dados SQLite. Nenhum serviço externo além de um endpoint Stellar RPC
- **AI-Ready** — Servidor Model Context Protocol (MCP) integrado expondo ferramentas para agentes de IA interagirem nativamente com os dados do Sorokeep
- **Segurança Avançada** — Integra com AWS Secrets Manager e HashiCorp Vault para resolução segura de chaves
- **Implantações Production-Ready** — Inclui Dockerfile, templates de serviço systemd e GitHub Actions para integração CI/CD

## Instalação

**Requisitos:** Node.js 22+

```bash
# A partir do código-fonte
git clone https://github.com/AbdulmalikAlayande/sorokeep.git
cd sorokeep
npm install
npm run build

# Executar diretamente
npx tsx src/index.ts --help

# Ou vincular globalmente após compilar
npm link
sorokeep --help
```

<!--
# npm (em breve)
npm install -g sorokeep
-->

## Início Rápido

```bash
# 1. Registre um contrato para monitoramento
sorokeep watch CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --network testnet \
  --name "XLM Native Token"

# 2. Verifique a saúde atual do TTL
sorokeep status CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC

# 3. Configure um alerta webhook (dispara quando o TTL cai abaixo de 20.000 ledgers)
sorokeep alerts add \
  --contract CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --type webhook \
  --url https://your-server.com/webhook \
  --threshold 20000

# 4. Inicie o daemon de monitoramento
sorokeep daemon --network testnet
```

O daemon verifica os TTls a cada 5 minutos, dispara alertas quando os limites são atingidos, envia notificações de resolução quando os TTls se recuperam e estenda automaticamente as entradas se políticas de guarda estiverem configuradas.

## Comandos

### Opções Globais

As opções a seguir podem ser usadas com qualquer comando:

| Opção | Descrição |
|--------|-------------|
| `-y, --yes` | Ignora todas as confirmações em comandos destrutivos (ex.: `unwatch`). Útil em scripts e pipelines de CI para execução não interativa. |
| `-h, --help` | Mostra a ajuda de qualquer comando ou subcomando. |
| `-V, --version` | Imprime a versão do Sorokeep. |

> **Nota:** `--yes` ignora apenas as confirmações interativas. Para o comando `check`, use `--force` (veja abaixo) para ignorar as falhas de código de saída em CI.

### `sorokeep watch <contract-id>`

Registre um contrato para monitoramento. Conecta ao Stellar RPC, descobre as entradas de instância e código WASM do contrato, lê seus TTls e armazena tudo localmente.

```bash
sorokeep watch <contract-id> [options]
```

| Opção | Descrição | Padrão |
|-------|-----------|--------|
| `-n, --name <name>` | Nome legível do contrato | — |
| `--network <network>` | `testnet` ou `mainnet` | `testnet` |
| `-r, --rpc-url <url>` | Endpoint Stellar RPC customizado | Padrão da rede |
| `--storage-keys <keys>` | Chaves de armazenamento XDR base64 separadas por vírgula para rastrear | — |

**Exemplo de saída:**

```
$ sorokeep watch CDLZFC3S...CYSC --network testnet --name "XLM Native Token"

✔ Contract XLM Native Token registered successfully.

  Contract: XLM Native Token (CDLZFC3S...CYSC)
  Network:  testnet
  Entries:  1 discovered
  Instance TTL: 113,918 ledgers (~7d 6h)  OK

  Run 'sorokeep status CDLZFC3S...CYSC' to check TTLs anytime.
  Run 'sorokeep guard CDLZFC3S...CYSC' to enable auto-extension.
```

A descoberta de entradas acontece em camadas:

1. **Determinística** (automática) — Entradas de instância do contrato e código WASM, derivadas do ID do contrato e hash WASM. Sempre rastreadas.
2. **Baseada em footprint** (daemon) — Descobertas escaneando eventos de transações on-chain para chaves de armazenamento que seu contrato utiliza.
3. **Manual** (opt-in) — Chaves de armazenamento específicas declaradas via `--storage-keys`.

---

### `sorokeep status <contract-id>`

Exiba a saúde atual do TTL de um contrato monitorado. Lê do banco de dados local — sem chamada RPC.

```bash
sorokeep status <contract-id>
```

Mostra o nome do contrato, rede, último ledger verificado e uma tabela de todas as entradas rastreadas com TTL restante em ledgers e tempo legível, além de um indicador de status (OK / Warning / Critical).

---

### `sorokeep daemon`

Inicie o processo de monitoramento de longa duração.

```bash
sorokeep daemon [options]
```

| Opção | Descrição | Padrão |
|-------|-----------|--------|
| `--network <network>` | Rede a monitorar | `testnet` |
| `--interval <ms>` | Intervalo de polling em milissegundos (mín: 10.000) | `300000` (5 min) |
| `-r, --rpc-url <url>` | Endpoint RPC customizado | Padrão da rede |

Cada ciclo realiza três fases:

1. **Monitor** — Busca TTls atualizados para todos os contratos, detecta cruzamentos de limites e resolve alertas recuperados
2. **Entrega** — Envia alertas pendentes para os canais webhook e Slack configurados
3. **Auto-Extend** — Estende TTls para contratos com políticas de guarda ativas

O daemon lida com desligamento gracioso em `SIGINT`/`SIGTERM` e inclui um guarda de re-entrância para prevenir sobreposição de ciclos.

---

### `sorokeep alerts`

Gerencie configurações de alertas. Suporta cinco subcomandos.

#### `alerts add` — Crie um novo alerta

```bash
sorokeep alerts add [options]
```

| Opção | Descrição |
|-------|-----------|
| `--contract <id>` | ID do contrato para alertar (obrigatório) |
| `--type <type>` | `webhook` ou `slack` (obrigatório) |
| `--url <url>` | URL de POST do webhook (obrigatório para webhook) |
| `--channel <channel>` | Nome ou ID do canal Slack (obrigatório para slack) |
| `--threshold <ledgers>` | Dispara quando o TTL restante cai abaixo deste valor (obrigatório) |
| `--secret <secret>` | Segredo de assinatura HMAC para webhooks (gerado automaticamente se omitido) |

Para alertas webhook, um segredo de assinatura HMAC é gerado automaticamente (hex de 32 bytes) se você não fornecer um. O segredo é exibido uma vez no momento da criação — salve-o para verificar assinaturas de webhook no seu servidor. Veja [Assinatura de Webhook](#assinatura-de-webhook) para detalhes.

#### `alerts list` — Visualize alertas configurados

```bash
sorokeep alerts list --contract <id>
```

#### `alerts remove` — Delete uma configuração de alerta

```bash
sorokeep alerts remove --id <config-id>
```

#### `alerts test` — Envie um alerta de teste

```bash
sorokeep alerts test --id <config-id>
```

Dispara um evento sintético `threshold_crossed` através do pipeline real de entrega. Útil para verificar se seu endpoint webhook ou canal Slack está configurado corretamente antes de entrar em produção.

#### `alerts history` — Visualize atividade passada de alertas

```bash
sorokeep alerts history --contract <id> [--limit 20]
```

Exibe uma tabela de alertas disparados: timestamp, rótulo da entrada, TTL no momento do disparo, tipo de canal, status de entrega, contagem de retentativas e tempo de resolução.

---

### `sorokeep guard`

Configure políticas de extensão automática. Quando habilitado, o daemon estende automaticamente os TTls submetendo transações `ExtendFootprintTTLOp` usando um keypair Stellar financiado.

```bash
sorokeep guard <contract-id> [options]
```

| Opção | Descrição | Padrão |
|-------|-----------|--------|
| `--target-ttl <ledgers>` | TTL para o qual estender as entradas | `100000` |
| `--threshold <ledgers>` | Estender quando o TTL cair abaixo deste valor | `20000` |
| `--keypair <secret>` | Chave secreta Stellar (para extensão única) | — |
| `--keypair-env <var>` | Nome da variável de ambiente contendo a chave secreta | — |
| `--auto-extend` | Habilitar extensão automática do daemon (requer `--keypair-env`) | — |
| `--dry-run` | Simular extensão e mostrar taxa estimada | — |
| `--disable` | Desabilitar extensão automática para este contrato | — |

**Modos de uso:**

```bash
# Verificar política atual
sorokeep guard <contract-id>

# Execução seca — veja a taxa estimada sem submeter
sorokeep guard <contract-id> --keypair S... --dry-run

# Extensão imediata única
sorokeep guard <contract-id> --keypair S...

# Habilitar extensão automática para o daemon
sorokeep guard <contract-id> --keypair-env STELLAR_SECRET_KEY --auto-extend

# Desabilitar extensão automática
sorokeep guard <contract-id> --disable
```

**Segurança:** Chaves secretas nunca são armazenadas no banco de dados. Ao usar `--auto-extend`, apenas a chave pública e o nome da variável de ambiente são persistidos. O daemon resolve a chave secreta real do ambiente em tempo de execução.

---

### `sorokeep costs`

Visualize o histórico de extensões e gastos de aluguel de um contrato.

```bash
sorokeep costs <contract-id> [options]
```

| Opção | Descrição | Padrão |
|-------|-----------|--------|
| `--period <days>` | Mostrar custos dos últimos N dias | `30` |
| `--all` | Mostrar todo o histórico | — |

**A saída inclui:**

- Total de extensões e custo total em XLM
- Detalhamento por tipo de entrada (instance, wasm, persistent) com contagem e custo
- Projeção de custos de 30 dias extrapolada do período selecionado
- Tabela de extensões recentes: timestamp, rótulo da entrada, TTL antigo → novo TTL, custo em XLM, hash da transação

---

### `sorokeep restore`

Recupere entradas de ledger arquivadas via transações `RestoreFootprintOp`.

```bash
sorokeep restore <contract-id> [options]
```

| Opção | Descrição |
|-------|-----------|
| `--keypair <secret>` | Chave secreta Stellar |
| `--keypair-env <var>` | Variável de ambiente contendo a chave secreta |
| `--entry <keyXdr>` | Chave XDR específica da entrada para restaurar (repetível) |
| `--all` | Restaurar todas as entradas rastreadas do contrato |

Um de `--keypair` ou `--keypair-env` é obrigatório. Um de `--entry` ou `--all` é obrigatório (mutuamente exclusivos).

```bash
# Restaurar uma entrada específica
sorokeep restore <contract-id> --keypair-env STELLAR_SECRET_KEY --entry <base64-xdr>

# Restaurar todas as entradas rastreadas
sorokeep restore <contract-id> --keypair-env STELLAR_SECRET_KEY --all
```

---

### `sorokeep resources`

Visualize logs de uso de recursos (instruções CPU, bytes de memória, estruturas de taxas) de um contrato para acompanhar a eficiência de execução ao longo do tempo.

---

### `sorokeep budget`

Defina e monitore um orçamento mensal de extensões em XLM para um contrato. Previne gastos descontrolados se um contrato exigir extensões frequentes.

---

### `sorokeep channels`

Gerencie contas de canal financiadas usadas para submeter transações de extensão e restauração simultaneamente, evitando gargalos de número de sequência.

---

### `sorokeep inspect`

Inspecione estado on-chain diretamente. Pode analisar saldos de tokens do Stellar Asset Contract (SAC), comparar mudanças de estado e decodificar XDR sem intervenção manual.

---

### `sorokeep check`

Execute uma execução avulsa do ciclo de monitoramento sem iniciar o daemon de longa duração.

---

### `sorokeep db`

Tarefas de gerenciamento do banco de dados, incluindo migrações, backups e gerenciamento de cache de introspecção.

---

### `sorokeep completion`

Gere scripts de autocompletar para shell bash/zsh para habilitar completar por tabulação para todos os comandos do Sorokeep.

---

### `sorokeep contracts`

Liste todos os contratos monitorados rapidamente — uma visão de índice útil quando você gerencia mais de alguns contratos.

```bash
sorokeep contracts [opções]
```

| Opção | Descrição |
|--------|-------------|
| `--network <network>` | Filtrar por `testnet` ou `mainnet` |
| `--json` | Saída em JSON legível por máquina |

Exibe uma tabela com o ID do contrato (truncado), nome, rede, contagem de entradas, pior TTL restante e status (OK / Warning / Critical / Expired). Lê apenas do banco de dados local — instantâneo, sem chamadas RPC.

## Alertas

O Sorokeep entrega alertas através de múltiplos canais: **webhooks**, **Slack**, **Discord**, **Telegram**, **PagerDuty**, **Opsgenie**, **Microsoft Teams**, **Matrix**, **e-mail**, **Google Chat**, e um segundo canal de **Webhook v2** configurável. Cada alerta inclui um nível de gravidade e contexto rico sobre a entrada afetada. O Sorokeep utiliza uma arquitetura robusta e desacoplada de detecção e despacho com fila baseada em banco de dados.

### Comparação dos Canais Suportados

| Canal | Método de Autenticação | Limite de Taxa Típico | Formato do Payload | Complexidade de Configuração |
|---------|-------------|--------------------|----------------|------------------|
| **Webhook** | HMAC-SHA256 (`X-Sorokeep-Signature`) / Secret | Ilimitado (depende do destino) | JSON genérico | Baixa |
| **Webhook v2** | HMAC-SHA256 (`X-Sorokeep-Signature`) / Secret, cabeçalhos customizados | Ilimitado (depende do destino) | JSON genérico | Baixa |
| **Slack** | Token OAuth do Bot (`xoxb-...`) / URL do Webhook | 1 req/seg | JSON Slack Block Kit | Baixa |
| **PagerDuty** | Chave de Roteamento da Events API v2 | 120 req/min | JSON PagerDuty Event v2 | Baixa |
| **Opsgenie** | Chave de API | Depende do plano | JSON da Opsgenie Alert API | Baixa |
| **Discord** | URL do Webhook | 30 req/min por webhook | JSON Discord Embed | Baixa |
| **Telegram** | Token do Bot (`SOROKEEP_TELEGRAM_BOT_TOKEN`) | 30 msg/seg no geral (1 msg/seg por chat) | Texto formatado em HTML / Markdown | Média |
| **Microsoft Teams** | URL do Webhook (escopo de tenant) | Depende do conector | JSON MessageCard do Teams | Baixa |
| **Matrix** | ID da Sala | Depende do homeserver | Evento `m.room.message` do Matrix | Média |
| **E-mail** | Credenciais SMTP (host/porta/usuário/senha) | Depende do provedor SMTP | Texto simples + HTML | Média |
| **Google Chat** | URL do Webhook | Depende do espaço | JSON de cartão do Google Chat | Baixa |

> Precisa de um canal que não está listado aqui? Veja [Adicionando um Canal de Alerta](docs/adding-an-alert-channel.md) para implementar um plugin de canal customizado.

### Ciclo de Vida do Alerta

1. **Limite Atingido** — Durante cada ciclo de monitoramento, se o TTL restante de uma entrada cair abaixo de um limite configurado, o monitor grava um alerta `threshold_crossed` na fila do banco de dados.
2. **Entrega** — O despachante liga as linhas não entregues da fila e roteia o alerta para o canal configurado. Entregas com falha são retentadas em ciclos subsequentes, até 5 tentativas, e então abandonadas graciosamente. Sucesso marca a linha como entregue.
3. **Resolução** — Quando o TTL se recupera acima do limite (por exemplo, após uma extensão), o Sorokeep dispara uma notificação `alert_resolved` para todos os canais configurados.

### Níveis de Gravidade

A gravidade é calculada automaticamente com base em quanto TTL resta em relação ao limite configurado:

| Gravidade | Condição | Descrição |
|-----------|----------|-----------|
| **critical** | TTL restante < 25% do limite, ou TTL = 0 | Entrada em perigo imediato de arquivamento |
| **warning** | TTL restante abaixo do limite mas acima de 25% | Entrada precisa de atenção em breve |
| **info** | Alerta resolvido (TTL recuperado) | Entrada está saudável novamente |

### Entrega via Webhook

Alertas webhook são entregues como requisições HTTP POST com corpo JSON:

```json
{
  "type": "threshold_crossed",
  "severity": "warning",
  "contractId": "CDLZFC3S...",
  "contractName": "XLM Native Token",
  "network": "testnet",
  "entry": {
    "keyXdr": "AAAA1234...",
    "type": "instance",
    "label": "Contract Instance"
  },
  "threshold": {
    "configuredLedgers": 20000,
    "currentRemainingLedgers": 8500,
    "approximateTimeRemaining": "~13h 0m"
  },
  "firedAtLedger": 2500000,
  "timestamp": "2026-06-13T12:00:00.000Z"
}
```

### Assinatura de Webhook

Requisições webhook incluem uma assinatura HMAC-SHA256 no cabeçalho `X-Sorokeep-Signature` para verificação do payload:

```
X-Sorokeep-Signature: sha256=a1b2c3d4e5f6...
```

Para verificar no seu servidor:

```javascript
import { createHmac } from "node:crypto";

function verifySignature(payload, signature, secret) {
  const expected = "sha256=" + createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return signature === expected;
}
```

O segredo de assinatura é gerado automaticamente ao criar um alerta webhook (ou você pode fornecer o seu próprio com `--secret`). Ele é exibido uma vez no momento da criação — armazene-o com segurança.

### Entrega via Slack

Alertas Slack são enviados via [Slack Web API](https://api.slack.com/methods/chat.postMessage) usando Block Kit para formatação rica. As mensagens incluem ícones de gravidade, detalhes do contrato, TTL restante e dicas acionáveis.

**Configuração:**

1. Crie um app Slack com escopo `chat:write` em [api.slack.com/apps](https://api.slack.com/apps)
2. Instale o app no seu workspace e copie o Token OAuth do Bot User (`xoxb-...`)
3. Forneça o token via variável de ambiente:

```bash
export SOROKEEP_SLACK_TOKEN=xoxb-your-bot-token
```

Alternativamente, armazene o token no seu arquivo de configuração em `~/.sorokeep/config.yaml`:

```yaml
slackToken: "xoxb-your-bot-token"
```

A variável de ambiente tem precedência sobre o arquivo de configuração.

### Política de Retentativa

Entregas de alertas com falha são automaticamente retentadas em ciclos subsequentes do daemon. Após **5 falhas consecutivas**, o alerta é abandonado e nenhuma tentativa adicional é feita. Você pode visualizar o status de entrega e contagem de retentativas com `sorokeep alerts history`.

## Como Funciona

O Sorokeep é uma ferramenta de monitoramento off-chain. Ele lê dados do Stellar RPC, armazena localmente em SQLite e age sobre eles (alertas, extensão automática, restauração). Ele não roda on-chain e não requer que você modifique seus contratos.

```
                         ┌─────────────────────┐
                         │   Stellar Network    │
                         │  (testnet / mainnet) │
                         └──────────┬───────────┘
                                    │ RPC
                         ┌──────────▼───────────┐
                         │   Sorokeep    │
                         │                       │
                         │  ┌─────────────────┐  │
                         │  │  Monitor Cycle   │  │
                         │  │  (fetch TTLs,    │  │
                         │  │   detect alerts, │  │
                         │  │   resolve)       │  │
                         │  └────────┬────────┘  │
                         │           │            │
                         │  ┌────────▼────────┐  │
                         │  │   Dispatcher     │  │
                         │  │  (webhook/slack) │  │
                         │  └────────┬────────┘  │
                         │           │            │
                         │  ┌────────▼────────┐  │
                         │  │  Auto-Extend     │  │
                         │  │  (guard policy)  │  │
                         │  └─────────────────┘  │
                         │                       │
                         │  ┌─────────────────┐  │
                         │  │   SQLite DB      │  │
                         │  │  ~/.soroban-     │  │
                         │  │   sorokeep/     │  │
                         │  │   sorokeep.db    │  │
                         │  └─────────────────┘  │
                         └───────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              ┌──────────┐  ┌────────────┐  ┌────────────┐
              │ Webhooks │  │   Slack    │  │  Terminal  │
              └──────────┘  └────────────┘  └────────────┘
```

### O Ciclo do Daemon

A cada intervalo de polling (padrão: 5 minutos), o daemon executa três fases:

1. **Monitor** — Para cada contrato registrado, busca TTls atualizados do RPC, atualiza o banco de dados, verifica cada entrada contra cada limite de alerta configurado. Dispara `threshold_crossed` quando o TTL cai abaixo de um limite; dispara `alert_resolved` quando o TTL se recupera.

2. **Entrega** — Processa todos os alertas não entregues da fila do banco de dados. Roteia cada um para seu canal configurado (Webhook, Slack, Discord, Telegram, PagerDuty), marca entregas bem-sucedidas, incrementa contadores de retentativa em falhas e abandona graciosamente após 5 retentativas.

3. **Auto-Extend** — Para contratos com uma política de guarda ativa, verifica quais entradas têm TTL abaixo do limite da política e simula uma transação `ExtendFootprintTTLOp` via Stellar RPC. Se bem-sucedida, submete a transação, registra o custo exato em XLM e atualiza o uso do orçamento mensal do contrato para prevenir gastos descontrolados.

Para o fluxo de dados completo (ordem exata de chamadas, isolamento de falhas entre fases, onde uma nova contribuição tipicamente se encaixa), veja [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Armazenamento

Todo o estado é local. O Sorokeep armazena dados em `~/.sorokeep/sorokeep.db` (SQLite com modo WAL). Nenhum serviço externo necessário além de um endpoint Stellar RPC.

**Tabelas do banco de dados:**

| Tabela | Finalidade |
|--------|------------|
| `contracts` | Contratos registrados com rede, nome, hash WASM |
| `contract_entries` | Entradas de ledger rastreadas com TTls e fonte de descoberta |
| `extension_policies` | Regras de extensão automática por contrato (limite, alvo, referência de keypair) |
| `alert_configs` | Canais de alerta, limites e segredos de webhook |
| `alerts_fired` | Registros de alertas disparados com status de entrega, contagem de retentativa e rastreamento de resolução |
| `extension_history` | Cada extensão de TTL com hash de transação e custo em XLM |

### Configuração

O Sorokeep armazena a configuração do usuário em `~/.sorokeep/config.yaml`:

```yaml
network: testnet
pollingIntervalSeconds: 300
slackToken: "xoxb-..."        # Opcional — também pode usar a variável de ambiente SOROKEEP_SLACK_TOKEN
rpcUrl: "https://..."         # Opcional — sobrepõe o padrão da rede
```

O arquivo de configuração é criado com permissões `0600` (leitura/escrita apenas do proprietário) para proteger valores sensíveis como o token do Slack.

## Estrutura do Projeto

```
sorokeep/
├── src/
│   ├── index.ts                 # Ponto de entrada CLI (Commander.js)
│   ├── commands/                # Handlers de comandos CLI (camada de apresentação leve)
│   │   ├── watch.ts             # Registro de contratos
│   │   ├── status.ts            # Exibição de saúde de TTL
│   │   ├── daemon.ts            # Monitor de longa duração
│   │   ├── alerts.ts            # CRUD de alertas + teste + histórico
│   │   ├── guard.ts             # Políticas de extensão automática
│   │   ├── costs.ts             # Relatório de custos de extensão
│   │   └── restore.ts           # Recuperação de entradas arquivadas
│   ├── core/                    # Lógica de negócio (sem dependências CLI)
│   │   ├── watch.ts             # Registro e descoberta de contratos
│   │   ├── monitor.ts           # Ciclo de polling, detecção de limites, resolução
│   │   ├── extension.ts         # Extensão de TTL, extensão automática, restauração, registro de custos
│   │   └── discovery.ts         # Descoberta de chaves de armazenamento baseada em footprint
│   ├── alerts/                  # Pipeline de entrega de alertas
│   │   ├── types.ts             # AlertEvent, AlertSeverity, buildAlertEvent
│   │   ├── dispatcher.ts        # Roteamento, lógica de retentativa, orquestração de entrega
│   │   ├── webhook.ts           # HTTP POST com assinatura HMAC-SHA256
│   │   └── slack.ts             # Slack Web API + formatação Block Kit
│   ├── daemon/                  # Ciclo de vida do daemon
│   │   └── loop.ts              # Início/parada, guarda de re-entrância, orquestração de ciclo
│   ├── rpc/                     # Wrapper do cliente Stellar RPC
│   │   └── client.ts            # Busca de instância/WASM, TTls em lote, extensão, restauração
│   ├── db/                      # Camada de banco de dados
│   │   ├── schema.sql           # Schema completo SQLite
│   │   ├── database.ts          # Inicialização, modo WAL, migrações ao vivo
│   │   └── repositories.ts      # Todas as funções de consulta
│   ├── logging/                 # Logging estruturado (pino)
│   └── utils/                   # Loader de configuração, formatação de TTL
├── tests/                       # Espelha a estrutura src/ — 891 testes em 66 arquivos
├── .github/workflows/           # CI (teste + verificação de tipo) e publicação
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── Dockerfile                   # Definição de container Docker
├── systemd/                     # Templates de serviço systemd para implantações Linux
├── LICENSE
└── CONTRIBUTING.md
```

**Camadas de arquitetura:**

- **Commands** (`src/commands/`) — Camada CLI leve. Analisa argumentos, chama core, formata saída terminal. Sem lógica de negócio.
- **Core** (`src/core/`) — Lógica de negócio pura. Testável sem rede ou CLI. O daemon reutiliza as mesmas funções.
- **RPC** (`src/rpc/`) — Wrapper do SDK Stellar. Todas as chamadas de rede passam por aqui. Lida com construção de transação, simulação, assinatura e submissão.
- **Alerts** (`src/alerts/`) — Pipeline de entrega. Formatação e transporte específicos do canal, roteamento, gerenciamento de retentativas.
- **DB** (`src/db/`) — Repositórios SQLite. Todas as consultas centralizadas aqui. Modo in-memory para testes.

## Stack Tecnológica

| Pacote | Finalidade |
|--------|------------|
| [TypeScript](https://www.typescriptlang.org/) | Linguagem da aplicação (ESM) |
| [@stellar/stellar-sdk](https://github.com/nicktomlin/js-stellar-sdk) | Interações com Stellar e Soroban RPC |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | Banco de dados local (síncrono, sem dependências externas) |
| [Commander.js](https://github.com/tj/commander.js) | Framework CLI |
| [pino](https://github.com/pinojs/pino) | Logging JSON estruturado |
| [chalk](https://github.com/chalk/chalk) / [ora](https://github.com/sindresorhus/ora) | Formatação de terminal e spinners |
| [yaml](https://github.com/eemeli/yaml) | Análise de arquivo de configuração |
| [Vitest](https://vitest.dev/) | Framework de testes |

## Testes

```bash
# Executar todos os testes
npm test

# Executar um arquivo de teste específico
npx vitest run tests/core/monitor.test.ts

# Modo observação
npx vitest
```

**891 testes** em **66 arquivos de teste** cobrindo:

- **Formatação** — Conversão de TTL, classificação de status, tempo legível
- **Banco de dados** — CRUD, cascata, upserts, desduplicação, filas de entrega de alertas
- **Cliente RPC** — Instância de contrato, código WASM, consultas de TTL em lote, simulação de transação
- **Watch** — Registro, re-watch, contratos SAC, tratamento de erros, isolamento de rede, introspecção
- **Ciclo de Monitoramento** — Atualização de TTL, detecção de limites, desduplicação de alertas, resolução, isolamento de falhas, escalação multi-limite, respostas parciais do RPC
- **Extension** — Extensão de TTL, avaliação de política de extensão automática, restauração, registro de custos, aplicação de orçamento
- **Despachante de Alertas** — Roteamento de canais, lógica de retentativa, limite máximo de retentativas, alertas abandonados (Slack, Discord, Telegram, Webhook, PagerDuty)
- **Webhook** — Assinatura HMAC-SHA256, tratamento de timeout, respostas HTTP de erro
- **Slack** — Resolução de token, estrutura Block Kit, validação de `body.ok`
- **Comandos CLI** — Alerts, budget, guard, costs, watch, status, daemon, check, restore, db, channels
- **Config** — Load/save, padrões, tratamento de falha de análise, permissões de arquivo
- **Daemon** — Início/parada, guarda de re-entrância, isolamento de erros de ciclo
- **Servidor MCP** — Cobertura de testes para todas as ferramentas MCP expostas

Todos os testes usam bancos de dados SQLite in-memory e respostas RPC mockadas — sem chamadas de rede, sem efeitos colaterais no sistema de arquivos. TDD é praticado em todo o projeto.

## Segurança e Procedência

Os pacotes do Sorokeep publicados no npm carregam uma [declaração de procedência verificada](https://docs.npmjs.com/generating-provenance-statements). Isso fornece um vínculo criptográfico e auditável entre o pacote npm publicado e a execução exata do GitHub Actions e o commit que o gerou.

Para verificar a procedência do seu pacote Sorokeep instalado, você pode conferir a [página do pacote no registro npm](https://www.npmjs.com/package/sorokeep) em busca do selo de procedência, ou executar o seguinte comando para verificar as assinaturas de auditoria do npm:

```bash
npm audit signatures
```

## Perguntas Frequentes

### Por que TypeScript, e não Rust?

O Sorokeep é uma ferramenta operacional off-chain, não um contrato inteligente. TypeScript foi escolhido porque:

1. O SDK JS do Stellar é a biblioteca cliente mais completa para interações com Soroban RPC
2. Desenvolvedores Soroban já têm Node.js em seu conjunto de ferramentas
3. Distribuição via npm significa instalação sem fricção
4. Os requisitos de desempenho (polling periódico de RPC) estão bem dentro das capacidades do Node.js
5. Maximiza o pool de contribuidores — a maioria dos desenvolvedores Soroban conhece TypeScript

### Minha chave secreta é armazenada em algum lugar?

Não. Quando você configura a extensão automática com `--keypair-env`, o Sorokeep armazena apenas a **chave pública** e o **nome da variável de ambiente** no banco de dados. A chave secreta real é resolvida do seu ambiente em tempo de execução. Se você usar `--keypair` para uma operação única, a chave é usada em memória e nunca persistida.

### O que acontece se o daemon travar no meio de um ciclo?

Cada fase (monitor, entrega, extensão automática) é envolvida em tratamento de erros isolado. Uma falha em uma fase não impede as outras de rodarem. Entregas de alertas são idempotentes — se uma entrega foi marcada como bem-sucedida, ela não será reenviada. Se o daemon reiniciar, alertas não entregues serão processados no próximo ciclo.

### Quais redes são suportadas?

Testnet (`https://soroban-testnet.stellar.org`) e Mainnet (`https://mainnet.sorobanrpc.com`). Você também pode apontar o Sorokeep para qualquer endpoint RPC customizado com `--rpc-url`.

### Como faço para registrar um contrato para monitoramento?

Execute `sorokeep watch <contract-id>` e forneça as opções de rede e RPC necessárias para sua implantação. As configurações de alerta exigem que o contrato já tenha sido registrado; use `sorokeep status <contract-id>` para inspecionar seu estado atual.

### Como posso verificar um canal de alerta antes de colocá-lo em produção?

Crie a configuração de alerta e execute `sorokeep alerts test --id <alert-config-id>`. O comando envia um evento sintético `threshold_crossed` através do caminho real de entrega; adicione `--dry-run` para imprimir o payload sem enviá-lo.

### Um alerta pode ser enviado para mais de um destino?

Sim. Para alertas de TTL, repita `--target <type:target>` ao executar `sorokeep alerts add`, por exemplo `--target webhook:https://... --target slack:alerts`. Alertas de recursos atualmente suportam apenas seu destino principal.

### Por que um alerta não chegou imediatamente?

Um alerta pode ser adiado quando sua janela de horário silencioso configurada está ativa; ele permanece pendente sem consumir uma retentativa. Falhas de entrega são retentadas pelo daemon, e uma entrega é abandonada após o limite de retentativas do canal ser atingido.

### Quais canais de alerta estão disponíveis?

O registro embutido atualmente inclui Webhook, Webhook v2, Slack, PagerDuty, Google Chat, Discord, Telegram, Opsgenie, Microsoft Teams, Matrix e e-mail. Execute `sorokeep alerts channels` para ver os canais registrados na instalação atual, incluindo canais fornecidos por plugins.

### O que acontece quando uma entrada de contrato já expirou?

Uma entrada expirada é arquivada e não pode ser estendida até ser restaurada. Execute `sorokeep restore <contract-id> --entry <key-xdr> --keypair-env <var>` (ou use `--all`), e deixe o watch existente continuar; a restauração exige uma chave de assinatura e XLM para as taxas de rede.

### E os alertas por e-mail?

Alertas por e-mail são suportados. Configure as credenciais SMTP (host/porta/usuário/senha) em `~/.sorokeep/config.yaml` ou através das variáveis de ambiente correspondentes; os envios por e-mail usam a mesma fila de retentativa baseada em banco de dados que os demais canais. Veja a [Referência de Configuração](docs/config-reference.md) para os nomes exatos dos campos.

### Como uso um endpoint RPC customizado?

Passe `--rpc-url <url>` para `sorokeep watch` ou `sorokeep daemon`, ou defina `rpcUrl` em `~/.sorokeep/config.yaml`. Um endpoint customizado substitui a URL RPC padrão de Testnet ou Mainnet para aquele comando.

### Posso executar um ciclo de monitoramento sem o daemon?

Sim — `sorokeep check <contract-id> --fail-under <ledgers>` executa um único ciclo de monitoramento avulso e sai com código 1 se qualquer entrada rastreada estiver abaixo desse TTL. Use `--force` em CI quando quiser reportar a saúde do TTL sem falhar o build.

### Como restauro uma entrada arquivada?

Execute `sorokeep restore <contract-id> --keypair-env STELLAR_SECRET_KEY --all` para restaurar todas as entradas rastreadas, ou passe `--entry <base64-xdr>` para restaurar uma entrada específica. O comando exige `--keypair` ou `--keypair-env`.

### Como vejo quanto já gastei em extensões?

Execute `sorokeep costs <contract-id>` para ver o total de extensões, custo total em XLM, um detalhamento por tipo de entrada e uma projeção de 30 dias. Use `--period <days>` para alterar a janela de consulta ou `--all` para o histórico completo.

### O que `sorokeep guard --dry-run` faz?

Execute `sorokeep guard <contract-id> --keypair S... --dry-run` para simular a transação de extensão e ver a taxa estimada sem enviar nada à rede. Isso é útil para verificar o custo antes de habilitar a extensão automática ou realizar uma extensão pontual.

## Roadmap

- Interface de plugin para canais de alerta — para que um novo canal (Matrix, MS Teams, e-mail) não exija modificar o código de despacho central ou o schema do banco de dados
- Endpoint Prometheus `/metrics` para equipes com stacks de observabilidade existentes
- GitHub Action reutilizável encapsulando `sorokeep check` para verificações de TTL integradas a CI
- Dashboard web para monitoramento visual de TTL
- Operações em lote multi-contrato

## Obtendo Ajuda

**Problemas com o daemon?** Veja [docs/troubleshooting.md](docs/troubleshooting.md) (em inglês) para um guia completo cobrindo modos de falha comuns (ciclos travados, alertas que não disparam, auto-extensão bloqueada, erros de RPC) com comandos de diagnóstico e passos de resolução.

Se você estiver com dúvidas ou problemas:
- Consulte as [issues abertas](https://github.com/AbdulmalikAlayande/sorokeep/issues)
- Entre em contato no X: [@The_good_man02](https://twitter.com/The_good_man02)

Para problemas de segurança (vazamento de chaves, transações não intencionais), veja [SECURITY.md](SECURITY.md) em vez de abrir uma issue pública.

## Contribuir

Contribuições são bem-vindas. Veja [CONTRIBUTING.md](CONTRIBUTING.md) para diretrizes, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) para como o sistema funciona em tempo de execução e [SECURITY.md](SECURITY.md) para relato de vulnerabilidades. Este projeto segue um [Código de Conduta](CODE_OF_CONDUCT.md).

## Licença

[MIT](LICENSE)

## Autor

**Abdulmalik Alayande**

- GitHub: [@AbdulmalikAlayande](https://github.com/AbdulmalikAlayande)
- X: [@The_good_man02](https://twitter.com/The_good_man02)
