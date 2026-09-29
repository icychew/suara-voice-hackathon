[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9.-]+$')]
    [string]$HostName,

    [Parameter(Mandatory = $true)]
    [string]$SshKeyPath,

    [ValidatePattern('^[a-z0-9.-]+$')]
    [string]$Domain = 'demo.suaraproject.tech',

    [ValidatePattern('^[a-z_][a-z0-9_-]*$')]
    [string]$SshUser = 'opc'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$resolvedKey = (Resolve-Path -LiteralPath $SshKeyPath).Path
$deployRoot = Join-Path $projectRoot 'deploy\oracle'
$distRoot = Join-Path $projectRoot 'dist'
$voiceServer = Join-Path $projectRoot 'server\voice-facade.mjs'
$archivePath = Join-Path ([System.IO.Path]::GetTempPath()) ("suara-dist-{0}.tgz" -f [guid]::NewGuid().ToString('N'))
$remote = "${SshUser}@${HostName}"
$sshOptions = @(
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'IdentitiesOnly=yes',
    # Verify the host fingerprint out of band and provision known_hosts before deploying.
    '-o', 'StrictHostKeyChecking=yes',
    '-i', $resolvedKey
)
$remoteStage = $null

Push-Location $projectRoot
try {
    pnpm test
    if ($LASTEXITCODE -ne 0) { throw 'Prototype tests failed.' }

    pnpm build
    if ($LASTEXITCODE -ne 0) { throw 'Oracle demo build failed.' }

    if (Test-Path -LiteralPath (Join-Path $distRoot 'suara-operator-only.json')) {
        throw 'Operator-only artifacts cannot be deployed.'
    }

    if (-not (Test-Path -LiteralPath (Join-Path $distRoot 'prototype\index.html'))) {
        throw 'The production prototype entry point is missing.'
    }

    tar -czf $archivePath -C $distRoot .
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the deployment archive.' }

    $remoteStageOutput = ssh @sshOptions $remote 'umask 077; mktemp -d /tmp/suara-deploy.XXXXXXXX'
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the remote staging directory.' }
    $remoteStage = ($remoteStageOutput | Out-String).Trim()
    if ($remoteStage -notmatch '^/tmp/suara-deploy\.[A-Za-z0-9]+$') {
        throw "The host returned an unsafe staging path: $remoteStage"
    }

    scp @sshOptions $archivePath "${remote}:${remoteStage}/suara-dist.tgz"
    if ($LASTEXITCODE -ne 0) { throw 'Could not upload the release archive.' }

    scp @sshOptions (Join-Path $deployRoot 'nginx-suara-demo.conf') "${remote}:${remoteStage}/nginx-suara-demo.conf"
    if ($LASTEXITCODE -ne 0) { throw 'Could not upload the Nginx configuration.' }

    scp @sshOptions (Join-Path $deployRoot 'nginx-suara-demo-tls.conf') "${remote}:${remoteStage}/nginx-suara-demo-tls.conf"
    if ($LASTEXITCODE -ne 0) { throw 'Could not upload the TLS Nginx configuration.' }

    scp @sshOptions (Join-Path $deployRoot 'bootstrap-oracle-linux.sh') "${remote}:${remoteStage}/suara-bootstrap.sh"
    if ($LASTEXITCODE -ne 0) { throw 'Could not upload the host bootstrap script.' }

    scp @sshOptions (Join-Path $deployRoot 'publish-release.sh') "${remote}:${remoteStage}/suara-publish-release.sh"
    if ($LASTEXITCODE -ne 0) { throw 'Could not upload the release script.' }

    scp @sshOptions (Join-Path $deployRoot 'rollback-release.sh') "${remote}:${remoteStage}/suara-rollback-release.sh"
    if ($LASTEXITCODE -ne 0) { throw 'Could not upload the rollback script.' }

    scp @sshOptions (Join-Path $deployRoot 'enable-tls.sh') "${remote}:${remoteStage}/suara-enable-tls.sh"
    if ($LASTEXITCODE -ne 0) { throw 'Could not upload the TLS script.' }

    scp @sshOptions $voiceServer "${remote}:${remoteStage}/voice-facade.mjs"
    if ($LASTEXITCODE -ne 0) { throw 'Could not upload the voice-facade service.' }

    scp @sshOptions (Join-Path $deployRoot 'suara-voice.service') "${remote}:${remoteStage}/suara-voice.service"
    if ($LASTEXITCODE -ne 0) { throw 'Could not upload the voice-facade systemd unit.' }

    scp @sshOptions (Join-Path $deployRoot 'suara-voice.env.example') "${remote}:${remoteStage}/suara-voice.env.example"
    if ($LASTEXITCODE -ne 0) { throw 'Could not upload the voice-facade environment template.' }

    scp @sshOptions (Join-Path $deployRoot 'install-voice-facade.sh') "${remote}:${remoteStage}/suara-install-voice-facade.sh"
    if ($LASTEXITCODE -ne 0) { throw 'Could not upload the voice-facade installer.' }

    $remoteCommand = @(
        "sudo install -d -o root -g root -m 0755 /usr/local/share/suara",
        "sudo install -o root -g root -m 0644 '${remoteStage}/nginx-suara-demo.conf' /usr/local/share/suara/nginx-suara-demo.conf",
        "sudo install -o root -g root -m 0644 '${remoteStage}/nginx-suara-demo-tls.conf' /usr/local/share/suara/nginx-suara-demo-tls.conf",
        "sudo install -o root -g root -m 0755 '${remoteStage}/suara-rollback-release.sh' /usr/local/sbin/suara-rollback-release",
        "sudo install -o root -g root -m 0755 '${remoteStage}/suara-enable-tls.sh' /usr/local/sbin/suara-enable-tls",
        "sudo bash '${remoteStage}/suara-bootstrap.sh' '$Domain' /usr/local/share/suara/nginx-suara-demo.conf /usr/local/share/suara/nginx-suara-demo-tls.conf",
        "sudo bash '${remoteStage}/suara-install-voice-facade.sh' '$Domain' '${remoteStage}/voice-facade.mjs' '${remoteStage}/suara-voice.service' '${remoteStage}/suara-voice.env.example'",
        "sudo bash '${remoteStage}/suara-publish-release.sh' '${remoteStage}/suara-dist.tgz' '$Domain'"
    ) -join ' && '

    ssh @sshOptions $remote $remoteCommand
    if ($LASTEXITCODE -ne 0) { throw 'The Oracle host rejected the release.' }

    Write-Host "Published the Suara site and voice demo to http://${Domain}/"
    Write-Host 'Add DNS and TLS only after the HTTP origin check passes.'
}
finally {
    Pop-Location
    if ($remoteStage -and $remoteStage -match '^/tmp/suara-deploy\.[A-Za-z0-9]+$') {
        ssh @sshOptions $remote "rm -rf -- '$remoteStage'"
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not remove remote staging directory $remoteStage."
        }
    }
    if (Test-Path -LiteralPath $archivePath) {
        Remove-Item -LiteralPath $archivePath -Force
    }
}
