# Roteiro do agente Radar (tarefa agendada)

Contrato entre o agente (Claude) e a API. A API não fala com a Microsoft: o agente lê o SharePoint/OneDrive em **somente leitura** e grava o resultado aqui. Esquema e rotas: [ARQUITETURA.md](ARQUITETURA.md).

Credenciais: o agente usa a chave `agente-radar` (permissões `agente, leitura, pedidos, fontes, restrito`) no cabeçalho `x-api-key`. Ela vem do cofre de segredos da tarefa, nunca de arquivo do repositório. O domínio do serviço precisa estar liberado em Admin settings › Capabilities.

## Passo a passo de cada execução

1. **Acordar a API.** `GET /v1/saude` (sem chave). No plano free leva até ~1 min; tente de novo a cada 15 s por até 90 s. Se não responder `{"ok":true}`, encerre a rodada e registre o erro; não grave nada.
2. **Listar fontes.** `GET /v1/fontes`. Processe só as de `ativa: true`.
3. **Para cada fonte:**
   1. Resolva a pasta pelo `link` (ou por `driveId`/`itemId`, se já preenchidos).
      - Sem acesso → `PATCH /v1/agente/fontes/{id}` com `{"status":"sem_acesso","mensagem":"..."}` e passe para a próxima.
      - Link que não resolve → `{"status":"link_invalido","mensagem":"..."}`.
      - Resolveu → `{"driveId":"...","itemId":"...","status":"pronta"}`.
   2. Liste os arquivos. Respeite `subpastas`; pule o que casa com `ignorar` (aceita `*` no fim); trate o conteúdo de `restritas` com `usoRestrito: true`.
   3. Leia a `planilhaControle` e os documentos. Extraia, por atestado: `id`, `emitente`, `esfera`, `ano`, `emissao`, `contrato`, `frentes`, `tecnologias`, `quantitativos[]` (com `trecho` literal), `forca` (A/B/C/?), `nivelEvidencia`, `alertas`, `destaque`, `versao`, `usoRestrito`, `link`, `textoLegivel`.
   4. Monte `prazos` e `lacunas` a partir da análise.
   5. Grave o estado completo da fonte (próxima seção).
4. **Atender a fila.** `GET /v1/agente/pedidos` (padrão `na_fila`). Para cada pedido: `PATCH` com `{"status":"processando"}`, consulte o acervo (`/v1/atestados`, `/v1/quantitativos`), depois `PATCH` com `{"status":"concluido","resultado":{...}}` ou `{"status":"erro","erro":"..."}`.

## Gravação do estado

```http
PUT /v1/agente/fontes/{fonte}/estado
x-api-key: <chave agente-radar>
Content-Type: application/json
```

```json
{
  "rodada":   { "rodadaId": "2026-10-12", "versaoEsquema": "1.0", "tipo": "completa",
                "geradoEm": "2026-10-12T09:00:00Z", "arquivosLidos": 99, "novos": 0, "alterados": 1 },
  "atestados": [ { "id": "205", "emitente": "...", "esfera": "estadual", "frentes": ["SD","INF"],
                   "tecnologias": ["GLPI"], "forca": "A", "nivelEvidencia": 1,
                   "quantitativos": [ { "metrica": "usuarios", "valor": 3500, "natureza": "executado",
                                        "trecho": "aproximadamente 3.500 usuários" } ],
                   "alertas": [], "versao": { "vigente": true }, "usoRestrito": false, "link": "..." } ],
  "prazos":   [ { "contrato": "...", "data": "2026-10-24", "tipo": "fim_contrato", "acao": "..." } ],
  "lacunas":  [ { "requisito": "...", "exigido": "≥ 500 VMs", "evidencia": "...", "situacao": "lacuna" } ]
}
```

Regras que a API aplica:

- É **substituição**: o que não estiver no corpo some do banco. Envie sempre o estado completo, nunca um delta. Se a leitura falhou ou veio parcial, **não grave**: o banco mantém a rodada anterior.
- `versaoEsquema` deve ser `"1.0"`; todo atestado precisa de `id` (texto); corpo até 2 MB. `natureza` é `executado` ou `contratado`; `esfera` é `federal | estatal | estadual | privado | nao_identificado`.
- Não envie `diasRestantes` nem `severidade`: a API calcula no dia.
- Resposta de sucesso: `{ "ok": true, "fonte": "...", "atestados": N, "prazos": N, "lacunas": N }`. Erro `400` traz o motivo em `erro`.

## Verificação ao fim

`GET /v1/rodadas?fonte={id}&limit=1` deve mostrar a rodada recém-gravada, e `GET /v1/fontes` a fonte com `status: pronta` e `ultimaLeitura` atual. Divergência vira alerta no resumo da execução.
