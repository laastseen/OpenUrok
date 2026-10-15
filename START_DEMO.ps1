$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$port = 8080
$python = $null
if (Get-Command py -ErrorAction SilentlyContinue) { $python = 'py' }
elif (Get-Command python -ErrorAction SilentlyContinue) { $python = 'python' }
else { Write-Host 'Python не найден. Установите Python или запустите папку через локальный web-server.'; Read-Host; exit 1 }
Start-Process powershell -ArgumentList '-NoExit','-Command',"Set-Location '$PSScriptRoot'; & $python -m http.server $port"
Start-Sleep -Seconds 2
Start-Process "http://localhost:$port/index.html"
Start-Process "http://localhost:$port/teacher.html"
