$ErrorActionPreference = "Stop"

$candidates = @()
if ($env:LOCALAPPDATA) {
  $candidates += Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\DevToolsActivePort"
}
if ($HOME) {
  $candidates += Join-Path $HOME "Library/Application Support/Google/Chrome/DevToolsActivePort"
  $candidates += Join-Path $HOME ".config/google-chrome/DevToolsActivePort"
  $candidates += Join-Path $HOME ".config/chromium/DevToolsActivePort"
}

$portFile = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $portFile) {
  throw "DevToolsActivePort not found. Enable remote debugging in Chrome at chrome://inspect/#remote-debugging (or launch Chrome with --remote-debugging-port=9222)."
}

$lines = Get-Content $portFile
$uri = [Uri]"ws://127.0.0.1:$($lines[0])$($lines[1])"
$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ct = [System.Threading.CancellationToken]::None
Write-Host "[cdp-daemon] Connecting to visible Chrome at $uri (click Allow ONCE in Chrome if prompted)..."
$ws.ConnectAsync($uri, $ct).GetAwaiter().GetResult()
Write-Host "[cdp-daemon] Connected to Chrome!"

$script:msgId = 1

function Invoke-Cdp($method, $params = @{}, $sessionId = $null) {
  $id = $script:msgId++
  $obj = @{ id = $id; method = $method; params = $params }
  if ($sessionId) { $obj.sessionId = $sessionId }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress -Depth 10))
  $ws.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).GetAwaiter().GetResult()
  $buf = New-Object byte[] 65536
  while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
    $ms = New-Object System.IO.MemoryStream
    do {
      $res = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), $ct).GetAwaiter().GetResult()
      $ms.Write($buf, 0, $res.Count)
    } while (-not $res.EndOfMessage)
    $msg = ([System.Text.Encoding]::UTF8.GetString($ms.ToArray())) | ConvertFrom-Json
    if ($msg.id -eq $id) { return $msg }
  }
  throw "WebSocket closed"
}

function Get-PageSession($urlMatch = "*8090*") {
  $targets = (Invoke-Cdp "Target.getTargets").result.targetInfos
  if (-not $urlMatch) { $urlMatch = "*8090*" }
  $t = $targets | Where-Object { $_.type -eq "page" -and $_.url -like $urlMatch } | Select-Object -First 1
  if (-not $t) {
    $t = $targets | Where-Object { $_.type -eq "page" } | Select-Object -First 1
  }
  if (-not $t) { throw "No page target found" }
  return (Invoke-Cdp "Target.attachToTarget" @{ targetId = $t.targetId; flatten = $true }).result.sessionId
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:9224/")
$listener.Start()
Write-Host "[cdp-daemon] Listening on http://127.0.0.1:9224/"

while ($listener.IsListening -and $ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $sr = [System.IO.StreamReader]::new($req.InputStream, [System.Text.Encoding]::UTF8)
    $rawBody = $sr.ReadToEnd()
    $body = if ($rawBody) { $rawBody | ConvertFrom-Json } else { @{} }
    if ($body.listTargets) {
      $targets = (Invoke-Cdp "Target.getTargets").result.targetInfos | Where-Object { $_.type -eq "page" }
      $outVal = ($targets | Select-Object targetId, title, url | ConvertTo-Json -Compress)
    } else {
      $sid = Get-PageSession $body.urlMatch
      if ($body.navigate) {
        $null = Invoke-Cdp "Page.navigate" @{ url = [string]$body.navigate } $sid
        Start-Sleep -Milliseconds 1200
      }
      if ($body.reload) {
        $null = Invoke-Cdp "Page.reload" @{ ignoreCache = $true } $sid
        if ($body.eval) { Start-Sleep -Milliseconds 1200 }
      }
      $outVal = "OK"
      if ($body.eval) {
        $ev = Invoke-Cdp "Runtime.evaluate" @{
          expression = [string]$body.eval
          awaitPromise = $true
          returnByValue = $true
        } $sid
        if ($ev.result.exceptionDetails) {
          $outVal = "ERROR: " + ($ev.result.exceptionDetails | ConvertTo-Json -Compress)
        } else {
          $val = $ev.result.result.value
          if ($null -ne $val -and ($val -isnot [string]) -and ($val -isnot [ValueType])) {
            $outVal = ($val | ConvertTo-Json -Compress -Depth 8)
          } else {
            $outVal = [string]$val
          }
        }
      }
    }
    $outBytes = [System.Text.Encoding]::UTF8.GetBytes($outVal)
    $res.StatusCode = 200
    $res.ContentType = "text/plain; charset=utf-8"
    $res.OutputStream.Write($outBytes, 0, $outBytes.Length)
  } catch {
    $errBytes = [System.Text.Encoding]::UTF8.GetBytes("ERROR: $_")
    $res.StatusCode = 500
    $res.OutputStream.Write($errBytes, 0, $errBytes.Length)
  } finally {
    $res.Close()
  }
}
