# API do Radar de Atestados CTC

O agente Radar de Atestados continua rodando no Claude e grava o estado analisado (atestados, quantitativos, prazos, lacunas) nesta API. Outros agentes e aplicações leem pela mesma API, cada um com sua chave.

```
SharePoint / OneDrive ──(só leitura)──> Agente Radar (Claude) ──(chave agente)──> API no Render ──> MongoDB Atlas M0
                                                                                      ^
                                     Outros agentes, fluxo de propostas, players ─────┘ (chaves de leitura e pedidos)
```

- **Banco:** MongoDB Atlas, cluster gratuito M0 (0,5 GB, 100 operações/s, sem backup automático).
- **API:** Node 20 + Express, serviço web gratuito do Render. Dorme após 15 minutos sem uso e leva cerca de 1 minuto para acordar.
- **Segurança:** cada consumidor tem uma chave (`x-api-key`), guardada só como hash. Só a chave do agente grava o estado. A senha do banco fica apenas nas variáveis do Render.

## 1. Publicar (uma vez)

### 1.1 MongoDB Atlas

1. Em cloud.mongodb.com, crie um projeto **Radar Atestados** e, dentro dele, um cluster **M0 (Free)**. Região: AWS São Paulo (`sa-east-1`) se aparecer para o M0; senão AWS N. Virginia (`us-east-1`).
2. **Database Access › Add New Database User:** usuário `radar_api`, senha forte gerada pelo Atlas, papel *Read and write to any database* restrito ao banco `radar` (Specific Privileges › `readWrite` em `radar`).
3. **Network Access:** libere os IPs de saída do serviço do Render (no Render: serviço › **Connect › Outbound**). Se o plano gratuito não mostrar IPs fixos, use `0.0.0.0/0` e mantenha a senha forte.
4. **Connect › Drivers:** copie a string `mongodb+srv://...` e troque `<db_password>` pela senha do passo 2.

### 1.2 Código no GitHub

Crie um repositório **privado** (ex.: `ctc/radar-atestados-api`) e envie todo o conteúdo desta pasta, exceto `node_modules`.

### 1.3 Render

1. Em dashboard.render.com: **New › Blueprint** › conecte o repositório. O Render lê o `render.yaml` e cria o serviço `radar-atestados-api` no plano Free.
2. Quando pedir `MONGODB_URI`, cole a string do Atlas. `ADMIN_TOKEN` é gerado sozinho.
3. Aguarde o deploy e abra `https://<servico>.onrender.com/v1/saude`. Deve responder `{"ok":true,...}`. Nos logs aparece `Carga inicial: 99 atestados, 21 prazos, 8 lacunas.`
4. Depois da primeira subida, mude `SEED_INICIAL` para `false` (a carga só roda com o banco vazio, mas assim fica explícito).

### 1.4 Criar as chaves

Copie o `ADMIN_TOKEN` em **Environment** no Render. No PowerShell:

```powershell
$api   = "https://<servico>.onrender.com"
$admin = @{ "x-admin-token" = "<ADMIN_TOKEN>" }

# Chave do agente (grava o estado, lê tudo, atende pedidos)
Invoke-RestMethod "$api/v1/admin/consumidores" -Method Post -Headers $admin -ContentType "application/json" `
  -Body '{"nome":"agente-radar","permissoes":["agente","leitura","pedidos","fontes","restrito"]}'

# Chave do player externo (lê e cria pedidos)
Invoke-RestMethod "$api/v1/admin/consumidores" -Method Post -Headers $admin -ContentType "application/json" `
  -Body '{"nome":"player-externo","permissoes":["leitura","pedidos"]}'
```

Cada resposta traz a `chave` **uma única vez**. Guarde num cofre de senhas. Para revogar: `Invoke-RestMethod "$api/v1/admin/consumidores/player-externo" -Method Delete -Headers $admin`.

| Permissão | Libera |
| --- | --- |
| `leitura` | `GET` de atestados, quantitativos, prazos, lacunas, rodadas, fontes |
| `pedidos` | Criar pedidos de cruzamento ou indexação e ler os próprios resultados |
| `fontes` | Cadastrar e alterar fontes (pastas do SharePoint/OneDrive) |
| `restrito` | Ver atestados de pastas restritas |
| `agente` | Gravar o estado analisado e atender a fila de pedidos (só o agente) |

### 1.5 Liberar a API para o agente no Claude

O ambiente onde o agente roda só alcança domínios liberados pela organização. Um Owner da organização no Claude precisa liberar o domínio do serviço (ex.: `radar-atestados-api.onrender.com`) em **Admin settings › Capabilities** (acesso à rede). Sem isso, as chamadas do agente para o Render são bloqueadas.

## 2. Como o agente grava

A cada rodada, para cada fonte ativa:

```http
PUT /v1/agente/fontes/{fonte}/estado
x-api-key: <chave do agente>
Content-Type: application/json

{ "rodada": {"rodadaId":"2026-10-12","versaoEsquema":"1.0","tipo":"completa","geradoEm":"...","arquivosLidos":99,"novos":0,"alterados":1},
  "atestados": [ { "id":"205", "emitente":"...", "esfera":"estadual", "frentes":["SD","INF"], "tecnologias":["GLPI"],
                   "quantitativos":[{"metrica":"usuarios","valor":3500,"natureza":"executado","trecho":"aproximadamente 3.500 usuários"}],
                   "forca":"A", "nivelEvidencia":1, "alertas":["assinatura_nao_verificavel"], "versao":{"vigente":true}, "usoRestrito":false, "link":"..." } ],
  "prazos":   [ { "contrato":"SPTC · DA 95/2021", "data":"2026-10-24", "tipo":"fim_contrato", "acao":"..." } ],
  "lacunas":  [ { "requisito":"...", "exigido":"≥ 500 VMs", "evidencia":"...", "situacao":"lacuna" } ] }
```

A gravação substitui o estado daquela fonte numa transação: ou entra tudo, ou nada. Depois o agente atende a fila: `GET /v1/agente/pedidos`, processa cada pedido e responde com `PATCH /v1/agente/pedidos/{id}` (`status` + `resultado`). Novas fontes cadastradas chegam com `status: aguardando_leitura`; o agente atualiza com `PATCH /v1/agente/fontes/{id}`.

## 3. Como os consumidores leem

Toda chamada leva `x-api-key`. Sem `?fonte=`, usa a fonte padrão; `?fonte=todas` busca em todas as ativas; `?fonte=a,b` em várias.

| Rota | Filtros | Retorna |
| --- | --- | --- |
| `GET /v1/saude` | (sem chave) | Estado do serviço; também acorda o Render |
| `GET /v1/rodadas` | `fonte`, `limit` | Últimas leituras: data, arquivos lidos, novos, alterados |
| `GET /v1/atestados` | `fonte`, `frente` (ex.: `INF,SD`), `forca` (ex.: `A,B`), `esfera`, `tecnologia`, `q`, `limit` | Atestados vigentes |
| `GET /v1/atestados/{id}` | `fonte` | Um atestado completo, com quantitativos e trechos |
| `GET /v1/quantitativos` | `fonte`, `metrica`, `min`, `natureza` | Um número por linha, com o trecho literal |
| `GET /v1/prazos` | `fonte`, `ate` (dias) | Pedidos de ACT com `diasRestantes` e `severidade` calculados no dia |
| `GET /v1/lacunas` | `fonte` | Requisitos sem prova suficiente |
| `GET /v1/fontes` | | Pastas cadastradas e status |
| `POST /v1/fontes` / `PATCH /v1/fontes/{id}` | | Cadastra ou altera uma pasta (permissão `fontes`) |
| `POST /v1/pedidos` / `GET /v1/pedidos/{id}` | | Pede cruzamento com edital ou leitura extra; lê o resultado |

Exemplos:

```bash
API=https://<servico>.onrender.com
curl -s "$API/v1/atestados?frente=INF&forca=A" -H "x-api-key: $CHAVE"
curl -s "$API/v1/quantitativos?metrica=vms&min=200&natureza=executado&fonte=todas" -H "x-api-key: $CHAVE"
curl -s "$API/v1/prazos?ate=30" -H "x-api-key: $CHAVE"
curl -s -X POST "$API/v1/pedidos" -H "x-api-key: $CHAVE" -H "Content-Type: application/json" \
  -d '{"tipo":"cruzamento","edital":"PE 273/2026","requisitos":[{"id":"9.9.2.5.1","texto":"...","metrica":"vms","minimo":500,"tecnologia":"Nutanix AHV"}]}'
```

O primeiro acesso depois de 15 minutos parados demora cerca de 1 minuto (o Render acorda o serviço). Use timeout de 90 segundos nos clientes ou chame `/v1/saude` antes.

## 4. Manutenção

- **Testes:** `npm test` roda 17 testes contra um banco em memória. Para testar contra o Atlas: `MONGODB_URI_TESTE=<uri> npm test` (cria e apaga um banco temporário).
- **Backup:** o M0 não tem backup automático. Uma exportação semanal com `mongodump --uri "<MONGODB_URI>" --db radar` resolve; o estado também pode ser reconstruído por uma rodada completa do agente.
- **Pausa do Atlas:** o M0 pausa após 30 dias sem nenhuma conexão. As rodadas do agente evitam isso.
- **Limites do plano gratuito do Render:** 750 horas/mês por workspace (cobre um serviço o mês todo), sem disco persistente e com reinícios eventuais. A própria Render não recomenda o plano gratuito para produção.
- **Criar as chaves:** `scripts/criar-chaves.ps1`. Roteiro do agente: `docs/AGENTE.md`. Arquitetura: `docs/ARQUITETURA.md`.
- **Regerar a carga a partir do painel:** `npm run estado-do-painel -- <painel.html> data/estado-inicial-governo2.json 2026-10-05`.
