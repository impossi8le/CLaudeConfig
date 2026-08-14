# ============================================================
#  Claude Desktop MCP - генератор конфига
#  Скрипт спрашивает ключи/токены и создаёт claude_desktop_config.json
#  Запуск: powershell -ExecutionPolicy Bypass -File setup-config.ps1
# ============================================================

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Claude Desktop MCP - настройка конфигурации" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# ------------------------------------------------------------
# Сбор ключей
# ------------------------------------------------------------
$ghToken   = Read-Host "GitHub Personal Access Token (Enter - пропустить)"
$tavilyKey = Read-Host "Tavily API Key (Enter - пропустить)"
$n8nUrl    = Read-Host "n8n URL (Enter - http://localhost:5678)"
$n8nToken  = Read-Host "n8n Bearer токен (Enter - пропустить)"
$sshHost   = Read-Host "SSH хост (Enter - пропустить)"
$sshUser   = Read-Host "SSH пользователь (Enter - пропустить)"
$sshPass   = Read-Host "SSH пароль (Enter - пропустить)" -AsSecureString
$routerKey = Read-Host "routerai.ru API ключ (Enter - пропустить)"

if ($n8nUrl -eq "") { $n8nUrl = "http://localhost:5678" }

# Конвертируем SecureString обратно в обычную строку
if ($sshPass -ne $null -and $sshPass.Length -gt 0) {
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sshPass)
    $sshPassPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} else {
    $sshPassPlain = ""
}

# ------------------------------------------------------------
# Формирование JSON
# ------------------------------------------------------------
$config = @{
    mcpServers = @{
        "local-memory" = @{
            command = "node"
            args = @("C:/Users/$env:USERNAME/.claude/mcp/memory-proxy.cjs")
            env = @{
                MCP_MEMORY_SERVER_CMD = "npx"
                MCP_MEMORY_SERVER_ARGS = "-y @modelcontextprotocol/server-memory"
            }
        }
        "mcp_docker" = @{
            command = "C:\Program Files\Docker\cli-plugins\docker-mcp.exe"
            args = @("gateway", "run")
            env = @{
                ProgramData = "C:\ProgramData"
                LOCALAPPDATA = "C:\Users\$env:USERNAME\AppData\Local"
                APPDATA = "C:\Users\$env:USERNAME\AppData\Roaming"
                USERPROFILE = "C:\Users\$env:USERNAME"
                SystemRoot = "C:\Windows"
            }
        }
        "filesystem" = @{
            command = "npx"
            args = @("-y", "@modelcontextprotocol/server-filesystem")
        }
        "sequential-thinking" = @{
            command = "npx"
            args = @("-y", "@modelcontextprotocol/server-sequential-thinking")
        }
        "anthropic-global-skills" = @{
            command = "npx"
            args = @("-y", "@modelcontextprotocol/server-filesystem", "C:/Users/$env:USERNAME/.claude/skills")
        }
        "github" = @{
            command = "C:/Users/$env:USERNAME/AppData/Local/github/github-mcp-server.exe"
            args = @("stdio")
            env = @{
                GITHUB_PERSONAL_ACCESS_TOKEN = $ghToken
            }
        }
        "fetch" = @{
            command = "python"
            args = @("-m", "mcp_server_fetch")
        }
        "chrome-devtools" = @{
            command = "npx"
            args = @("-y", "chrome-devtools-mcp@latest", "--browser-url=http://localhost:9223")
        }
        "web-search" = @{
            command = "node"
            args = @("C:/Users/$env:USERNAME/web-search/build/index.js")
        }
        "n8n-local" = @{
            command = "mcp-remote"
            args = @("$n8nUrl/mcp-server/http", "--allow-http", "--header", "Authorization: Bearer $n8nToken")
        }
        "curl-client" = @{
            command = "npx"
            args = @("-y", "@calibress/curl-mcp")
        }
        "alolite-ssh" = @{
            command = "npx"
            args = @("-y", "@alolite/ssh-mcp")
            env = @{
                SSH_HOST = $sshHost
                SSH_USER = $sshUser
                SSH_PASSWORD = $sshPassPlain
                PROGRAMDATA = "C:\ProgramData"
            }
        }
        "tavily-mcp" = @{
            command = "npx"
            args = @("-y", "tavily-mcp@latest")
            env = @{
                TAVILY_API_KEY = $tavilyKey
            }
        }
        "tavily2-mc" = @{
            command = "npx"
            args = @("-y", "tavily-mcp@latest")
            env = @{
                TAVILY_API_KEY = $tavilyKey
            }
        }
        "ssh-remote-server" = @{
            command = "npx"
            args = @("-y", "ssh-mcp", "--host=$sshHost", "--user=$sshUser", "--password=$sshPassPlain")
        }
        "google-sheets" = @{
            command = "npx"
            args = @("-y", "mcp-gsheets@latest")
            env = @{
                GOOGLE_PROJECT_ID = "YOUR_GOOGLE_PROJECT_ID"
                GOOGLE_APPLICATION_CREDENTIALS = "C:/Users/$env:USERNAME/google-sheets-key.json"
            }
        }
        "puppeteer" = @{
            command = "npx"
            args = @("-y", "@modelcontextprotocol/server-puppeteer")
        }
        "gmail-global" = @{
            command = "npx"
            args = @("@gongrzhe/server-gmail-autoauth-mcp")
        }
        "playwright" = @{
            command = "npx"
            args = @("-y", "@playwright/mcp@latest")
        }
    }
    deploymentMode = "3p"
    coworkUserFilesPath = "C:\Users\$env:USERNAME\Claude"
    preferences = @{
        launchPreviewPersistedWorkspaces = @()
        launchPreviewSessionScopedSessions = @()
        localAgentModeTrustedFolders = @()
        coworkScheduledTasksEnabled = $true
        coworkHipaaRestricted = $false
        ccdScheduledTasksEnabled = $false
        sidebarMode = "epitaxy"
        coworkWebSearchEnabled = $true
        remoteToolsDeviceName = "desktop"
    }
}

# Удаляем пустые ключи, чтобы не ломать серверы
if ($ghToken -eq "") { $config.mcpServers.Remove("github") }
if ($tavilyKey -eq "") { $config.mcpServers.Remove("tavily-mcp"); $config.mcpServers.Remove("tavily2-mc") }
if ($n8nToken -eq "") { $config.mcpServers.Remove("n8n-local") }
if ($sshHost -eq "") { $config.mcpServers.Remove("alolite-ssh"); $config.mcpServers.Remove("ssh-remote-server") }

# ------------------------------------------------------------
# Сохранение
# ------------------------------------------------------------
$outPath = "$env:APPDATA\Claude\claude_desktop_config.json"

# Создаём папку, если её нет
$outDir = Split-Path $outPath
if (-not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

$json = $config | ConvertTo-Json -Depth 10
$json | Set-Content -Path $outPath -Encoding UTF8

Write-Host ""
Write-Host "Готово! Конфиг сохранён:" -ForegroundColor Green
Write-Host "  $outPath" -ForegroundColor Yellow
Write-Host ""
Write-Host "Перезапустите Claude Desktop, чтобы изменения вступили в силу." -ForegroundColor Cyan
Write-Host ""
