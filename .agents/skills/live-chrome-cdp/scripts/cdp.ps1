param(
  [string]$Eval = "",
  [string]$UrlMatch = "*8090*",
  [string]$Navigate = "",
  [switch]$Reload,
  [switch]$ListTargets,
  [int]$TimeoutSec = 15
)

$payload = @{
  eval = $Eval
  urlMatch = $UrlMatch
  navigate = $Navigate
  reload = [bool]$Reload
  listTargets = [bool]$ListTargets
} | ConvertTo-Json -Compress

$resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:9224/" -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -ContentType "application/json; charset=utf-8" -TimeoutSec $TimeoutSec
Write-Output $resp.Content
