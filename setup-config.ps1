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
        "github" = @{
            command = "C:/Users/$env:USERNAME/AppData/Local/github/github-mcp-server.exe"
            args = @("stdio")
            env = @{
                GITHUB_PERSONAL_ACCESS_TOKEN = $ghToken
            }
        }
        "n8n-local" = @{
            command = "node"
            args = @(
                "C:/Users/$env:USERNAME/n8n-mcp-fix-proxy.mjs",
                "$n8nUrl/mcp-server/http",
                "--allow-http",
                "--header",
                "Authorization: Bearer $n8nToken"
            )
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
        "playwright" = @{
            command = "npx"
            args = @("-y", "@playwright/mcp@latest")
        }
        "orchestrator-mcp" = @{
            command = "node"
            args = @("C:/Users/$env:USERNAME/orchestrator-mcp/index.js")
            env = @{
                ROUTERAI_API_KEY = $routerKey
                ORCH_PRO_MODEL = "deepseek/deepseek-v4.1-flash"
                ORCH_FLASH_MODEL = "deepseek/deepseek-chat"
            }
        }
        "context7" = @{
            command = "npx"
            args = @("-y", "@upstash/context7-mcp")
        }
        "lean-ctx" = @{
            command = "lean-ctx"
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
