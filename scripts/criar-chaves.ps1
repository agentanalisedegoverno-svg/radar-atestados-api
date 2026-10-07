# Cria as chaves de API do Radar. Rode na sua máquina (PowerShell).
# O ADMIN_TOKEN é pedido sem eco e não é gravado; as chaves aparecem uma única vez, na tela.
param([string]$Api = "https://radar-atestados-api.onrender.com")

$sec = Read-Host "ADMIN_TOKEN (Render > servico > Environment)" -AsSecureString
$admin = @{ "x-admin-token" = [System.Net.NetworkCredential]::new("", $sec).Password }

Invoke-RestMethod "$Api/v1/saude" -TimeoutSec 90 | Out-Null   # acorda o servico

$consumidores = @(
  @{ nome = "agente-radar";   permissoes = @("agente","leitura","pedidos","fontes","restrito") },
  @{ nome = "player-externo"; permissoes = @("leitura","pedidos") }
)
foreach ($c in $consumidores) {
  $r = Invoke-RestMethod "$Api/v1/admin/consumidores" -Method Post -Headers $admin `
        -ContentType "application/json" -Body ($c | ConvertTo-Json) -TimeoutSec 90
  Write-Host "`n$($r.nome): $($r.chave)"
}
Write-Host "`nGuarde as chaves num cofre de senhas. Elas nao serao mostradas de novo."
