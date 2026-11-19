# Refresh the Windows portproxy rules that expose WSL sshd on IPv6/IPv4.
#
# WSL's NAT IPv4 address can change after a Windows or WSL restart. The plugin's
# access-info collector only *warns* when the rules are stale (it must not ask
# for administrator rights by itself). After a restart, or after changing the
# SSH port, run this script from an elevated PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\refresh-wsl-portproxy.ps1
#
# The rule created by the plugin setup forwards both IPv4 and IPv6 SSH to WSL.
param(
    [string]$Distro = 'Ubuntu',
    [int]$SshPort = 22
)

$ErrorActionPreference = 'Stop'

function Get-WslIpv4 {
    param([string]$DistroName)
    $out = & wsl.exe -d $DistroName --exec sh -c 'hostname -I' 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return (($out -join ' ') -split '\s+' | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1)
}

$ip = Get-WslIpv4 -DistroName $Distro
if (-not $ip) {
    throw "Could not determine the WSL IPv4 address for distro '$Distro'. Start WSL and retry."
}

Write-Host "WSL IPv4: $ip"
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$SshPort 2>$null | Out-Null
netsh interface portproxy delete v6tov4 listenaddress=:: listenport=$SshPort 2>$null | Out-Null
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$SshPort connectaddress=$ip connectport=$SshPort | Out-Null
netsh interface portproxy add v6tov4 listenaddress=:: listenport=$SshPort connectaddress=$ip connectport=$SshPort | Out-Null

$ruleName = "dsh_ssh_$SshPort"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if (-not $existing) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP `
        -LocalPort $SshPort -Action Allow -Profile Any | Out-Null
    Write-Host "Firewall rule '$ruleName' created."
}

Write-Host 'Current SSH portproxy rules:'
netsh interface portproxy show v4tov4
netsh interface portproxy show v6tov4
