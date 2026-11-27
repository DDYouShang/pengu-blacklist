param([switch]$CoreOnly)

$script:installerFile = $PSCommandPath
$script:pluginSource = $PSScriptRoot
$script:penguVersion = '1.1.6'
$script:penguUrl = 'https://github.com/PenguLoader/PenguLoader/releases/download/v1.1.6/pengu-loader-v1.1.6.zip'
$script:penguSha256 = 'D9AAFFD776A1594E4FB5EF060814C40CAB0CB4DE07F1F0CE3246E9C12EDA8836'

function Get-PenguDirectory([string]$Path) {
    if (-not $Path) { return }
    try {
        if (-not [IO.Path]::IsPathRooted($Path)) { return }
        $path = [IO.Path]::GetFullPath($Path)
        if ([IO.File]::Exists([IO.Path]::Combine($path, 'Pengu Loader.exe')) -and
            [IO.File]::Exists([IO.Path]::Combine($path, 'core.dll'))) {
            if ($path.Length -gt [IO.Path]::GetPathRoot($path).Length) { $path = $path.TrimEnd('\', '/') }
            $path
        }
    } catch {
        # Ignore malformed paths from stale shortcuts or uninstall entries.
    }
}

function Get-DefaultPenguDirectory([string]$Parent = [Environment]::GetFolderPath('LocalApplicationData')) {
    $basePath = Join-Path $Parent 'Pengu Loader'
    $candidate = $basePath
    $suffix = 2
    while ((Test-Path -LiteralPath $candidate) -and -not (Get-PenguDirectory $candidate)) {
        $candidate = "$basePath ($suffix)"
        $suffix++
    }
    $candidate
}

function Find-PenguDirectories {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $found = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

    foreach ($process in Get-Process -Name 'Pengu Loader' -ErrorAction SilentlyContinue) {
        if ($process.Path) {
            $root = Get-PenguDirectory ([IO.Path]::GetDirectoryName($process.Path))
            if ($root -and $found.Add($root)) { $root }
        }
    }

    $locations = [Collections.Generic.List[string]]::new()
    $uninstallKeys = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($app in Get-ItemProperty -Path $uninstallKeys -ErrorAction SilentlyContinue) {
        if ($app.DisplayName -notmatch 'Pengu\s*Loader') { continue }
        if ($app.InstallLocation) { $locations.Add($app.InstallLocation.Trim('"')) }
        if ($app.DisplayIcon -match '^"?(.+?\.exe)(?:"|,|$)') {
            $locations.Add([IO.Path]::GetDirectoryName($Matches[1]))
        }
    }

    $desktop = [Environment]::GetFolderPath('Desktop')
    $menus = @($desktop, [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'))
    try {
        $shell = New-Object -ComObject WScript.Shell
        foreach ($menu in $menus) {
            if (-not $menu -or $watch.ElapsedMilliseconds -ge 4500) { continue }
            $links = Get-ChildItem -LiteralPath $menu -Filter '*Pengu*.lnk' -File -ErrorAction SilentlyContinue
            foreach ($group in Get-ChildItem -LiteralPath $menu -Filter '*Pengu*' -Directory -ErrorAction SilentlyContinue) {
                $links += @(Get-ChildItem -LiteralPath $group.FullName -Filter '*.lnk' -File -ErrorAction SilentlyContinue)
            }
            foreach ($link in $links) {
                $target = $shell.CreateShortcut($link.FullName).TargetPath
                if ($target) { $locations.Add([IO.Path]::GetDirectoryName($target)) }
            }
        }
    } catch {
        # Registry and known folders still work when Windows shortcuts are unavailable.
    }

    $parents = @(
        $env:LOCALAPPDATA
        (Join-Path $env:LOCALAPPDATA 'Programs')
        $env:APPDATA
        $env:ProgramFiles
        ${env:ProgramFiles(x86)}
        (Join-Path $env:USERPROFILE 'Downloads')
        $desktop
    )
    foreach ($drive in [IO.DriveInfo]::GetDrives()) {
        if ($drive.DriveType -ne 'Fixed' -or -not $drive.IsReady) { continue }
        $parents += $drive.Name
        foreach ($name in 'Games', 'Apps', 'Tools', 'Downloads', 'Program Files') {
            $parents += [IO.Path]::Combine($drive.Name, $name)
        }
    }
    foreach ($parent in $parents | Where-Object { $_ } | Select-Object -Unique) {
        if ($watch.ElapsedMilliseconds -ge 4500) { break }
        foreach ($folder in Get-ChildItem -LiteralPath $parent -Directory -Filter 'Pengu*' -ErrorAction SilentlyContinue) {
            $locations.Add($folder.FullName)
        }
    }

    foreach ($path in $locations) {
        $root = Get-PenguDirectory $path
        if ($root -and $found.Add($root)) { $root }
        if ($watch.ElapsedMilliseconds -ge 4500) { break }
    }
}

function New-InstallWorkspace([string]$Parent) {
    $parentPath = (Get-Item -LiteralPath $Parent -ErrorAction Stop).FullName
    $name = '.pgbl-' + [IO.Path]::GetRandomFileName()
    [IO.Directory]::CreateDirectory([IO.Path]::Combine($parentPath, $name))
}

function Remove-InstallWorkspace([IO.DirectoryInfo]$Workspace, [string]$Parent) {
    $parentPath = (Get-Item -LiteralPath $Parent -ErrorAction Stop).FullName
    if ($Workspace.Parent.FullName -ne $parentPath -or $Workspace.Name -notmatch '^\.pgbl-[a-z0-9]{8}\.[a-z0-9]{3}$') {
        throw "无法确认安装临时目录 $($Workspace.FullName)"
    }
    try { [IO.Directory]::Delete($Workspace.FullName, $true) } catch { Write-Warning $_.Exception.Message }
}

function Install-BlacklistPlugin([string]$Directory, [IO.DirectoryInfo]$OuterWorkspace) {
    $pengu = Get-PenguDirectory $Directory
    if (-not $pengu) { throw '所选位置未找到 Pengu Loader.exe 和 core.dll。请重新选择目录。' }

    $plugin = Join-Path $pengu 'plugins\blacklist'
    $entry = Join-Path $plugin 'index.js'
    $lock = [IO.FileStream]::new((Join-Path $pengu '.pengu-blacklist-install.lock'),
        [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096,
        [IO.FileOptions]::DeleteOnClose)
    $workspace = $OuterWorkspace
    $rollbackFailed = $false
    $applied = [Collections.Generic.List[object]]::new()
    try {
        if ([IO.File]::Exists($entry) -and
            -not [IO.File]::ReadAllText($entry).Contains('PenguBlacklist')) {
            throw "plugins\blacklist 已被另一个插件占用。请检查 $plugin"
        }

        if (-not $workspace) { $workspace = New-InstallWorkspace $pengu }
        $payload = Join-Path $workspace.FullName 'files'
        $backups = Join-Path $workspace.FullName 'backups'
        $libSource = Join-Path $script:pluginSource 'lib'
        $files = @(
            foreach ($file in Get-ChildItem -LiteralPath $libSource -Recurse -File -Filter '*.js' -ErrorAction Stop) {
                $file.FullName.Substring($script:pluginSource.Length + 1)
            }
            if (-not [IO.File]::Exists((Join-Path $plugin 'config.json'))) { 'config.json' }
            'styles.css'
            'index.js'
        )
        foreach ($file in $files) {
            $staged = Join-Path $payload $file
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($staged))
            [IO.File]::Copy((Join-Path $script:pluginSource $file), $staged)
        }
        foreach ($file in $files) {
            $staged = Join-Path $payload $file
            $target = Join-Path $plugin $file
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
            $backup = $null
            if ([IO.File]::Exists($target)) {
                $backup = Join-Path $backups $file
                [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($backup))
                [IO.File]::Replace($staged, $target, $backup)
            } else {
                [IO.File]::Move($staged, $target)
            }
            $applied.Add(@{ Target = $target; Backup = $backup })
        }
    } catch {
        $failure = $_
        for ($index = $applied.Count - 1; $index -ge 0; $index--) {
            $change = $applied[$index]
            try {
                if ($change.Backup) {
                    [IO.File]::Copy($change.Backup, $change.Target, $true)
                } else {
                    [IO.File]::Delete($change.Target)
                }
            } catch {
                $rollbackFailed = $true
            }
        }
        if ($rollbackFailed -and -not $OuterWorkspace) {
            throw "安装中断，部分文件无法恢复。原文件备份位于 $($workspace.FullName) 。$($failure.Exception.Message)"
        }
        throw $failure
    } finally {
        try {
            if (-not $OuterWorkspace -and $workspace -and -not $rollbackFailed) {
                Remove-InstallWorkspace $workspace $pengu
            }
        } finally {
            $lock.Dispose()
        }
    }

    [pscustomobject]@{ Directory = $pengu; NewPengu = $false }
}

function Save-PenguPackage([string]$Destination) {
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $script:penguUrl -OutFile $Destination -UseBasicParsing -TimeoutSec 35 -ErrorAction Stop
}

function Install-PenguAndBlacklist([string]$Directory) {
    if (Get-PenguDirectory $Directory) { return (Install-BlacklistPlugin $Directory) }
    if (Test-Path -LiteralPath $Directory) { throw "目录已存在，请选择其他安装位置。 $Directory" }

    $parent = [IO.Path]::GetDirectoryName($Directory)
    $workspace = New-InstallWorkspace $parent
    try {
        $download = Join-Path $workspace.FullName 'pengu.zip'
        $extracted = Join-Path $workspace.FullName 'Pengu Loader'
        Save-PenguPackage $download
        if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $script:penguSha256) {
            throw 'Pengu Loader 安装包校验失败，请重试。'
        }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($download, $extracted)
        [void](Install-BlacklistPlugin $extracted -OuterWorkspace $workspace)
        $target = [IO.Path]::Combine($workspace.Parent.FullName, [IO.Path]::GetFileName($Directory))
        if ($target -ne [IO.Path]::GetFullPath($Directory)) { throw '无法确认 Pengu Loader 的安装位置。' }
        [IO.Directory]::Move($extracted, $target)
    } finally {
        Remove-InstallWorkspace $workspace $parent
    }
    [pscustomobject]@{ Directory = $target; NewPengu = $true }
}

if ($CoreOnly) { return }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

function Add-InstallerButton([string]$Title, [int]$Left, [int]$Top, [int]$Width) {
    $button = [Windows.Forms.Button]::new()
    $button.Text = $Title
    $button.SetBounds($Left, $Top, $Width, 32)
    $form.Controls.Add($button)
    $button
}

function Add-DirectoryChoice([string]$Directory, [switch]$Select) {
    if (-not $directories.Items.Contains($Directory)) { [void]$directories.Items.Add($Directory) }
    if ($Select -or $directories.SelectedIndex -lt 0) { $directories.SelectedItem = $Directory }
}

function Update-InstallDirectoryStatus {
    if (Get-PenguDirectory ([string]$directories.SelectedItem)) {
        $status.Text = '已找到 Pengu Loader，可以直接安装插件。'
    } else {
        $status.Text = '点「安装」会下载 Pengu Loader，并安装黑名单插件。'
    }
}

function Select-InstallFallback {
    if ($directories.SelectedIndex -lt 0) {
        Add-DirectoryChoice (Get-DefaultPenguDirectory)
    } else {
        Update-InstallDirectoryStatus
    }
}

function Select-InstallDirectory {
    $picker = [Windows.Forms.FolderBrowserDialog]::new()
    $picker.Description = '选择已有的 Pengu Loader 文件夹，或者选择放置 Pengu Loader 的位置。'
    $picker.SelectedPath = $env:LOCALAPPDATA
    if ([string]$directories.SelectedItem -and [IO.Directory]::Exists([string]$directories.SelectedItem)) {
        $picker.SelectedPath = [string]$directories.SelectedItem
    }
    try {
        if ($picker.ShowDialog($form) -ne 'OK') { return }
        $selected = $picker.SelectedPath
        $pengu = Get-PenguDirectory $selected
        if (-not $pengu -and [IO.Path]::GetFileName($selected) -eq 'plugins') {
            $pengu = Get-PenguDirectory ([IO.Path]::GetDirectoryName($selected))
        }
        if ($pengu) {
            Add-DirectoryChoice $pengu -Select
        } else {
            Add-DirectoryChoice (Join-Path $selected 'Pengu Loader') -Select
        }
    } finally {
        $picker.Dispose()
    }
}

function Set-InstallerBusy([bool]$Busy) {
    foreach ($control in $directories, $searchButton, $chooseButton, $installButton) {
        $control.Enabled = -not $Busy
    }
    $form.UseWaitCursor = $Busy
}

function Start-InstallerJob([string]$Action, [string]$Directory) {
    $worker = [PowerShell]::Create()
    $command = {
        param($Installer, $Action, $Directory)
        $ErrorActionPreference = 'Stop'
        . $Installer -CoreOnly
        switch ($Action) {
            'Search' { Find-PenguDirectories }
            'Install' { Install-BlacklistPlugin $Directory }
            'Download' { Install-PenguAndBlacklist $Directory }
        }
    }
    [void]$worker.AddScript($command.ToString()).AddArgument($script:installerFile)
    [void]$worker.AddArgument($Action).AddArgument($Directory)

    $script:job = @{
        Action = $Action
        Worker = $worker
        Result = $worker.BeginInvoke()
        Clock = [Diagnostics.Stopwatch]::StartNew()
    }
    Set-InstallerBusy $true
}

$form = [Windows.Forms.Form]::new()
$form.Text = '安装 Pengu 黑名单'
$form.AutoScaleDimensions = [Drawing.SizeF]::new(96, 96)
$form.AutoScaleMode = 'Dpi'
$form.ClientSize = [Drawing.Size]::new(576, 190)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = [Drawing.Font]::new('Microsoft YaHei UI', 9)

$label = [Windows.Forms.Label]::new()
$label.Text = '安装目录'
$label.SetBounds(20, 18, 150, 20)
$directories = [Windows.Forms.ComboBox]::new()
$directories.DropDownStyle = 'DropDownList'
$directories.SetBounds(20, 43, 536, 26)
$status = [Windows.Forms.Label]::new()
$status.SetBounds(20, 116, 536, 26)
$form.Controls.AddRange(@($label, $directories, $status))

$searchButton = Add-InstallerButton '自动搜索' 20 76 96
$chooseButton = Add-InstallerButton '选择目录…' 124 76 108
$installButton = Add-InstallerButton '安装' 376 144 86
$closeButton = Add-InstallerButton '关闭' 470 144 86
$form.AcceptButton = $installButton
$form.CancelButton = $closeButton

$script:job = $null
$script:canceledSearch = $null
$timer = [Windows.Forms.Timer]::new()
$timer.Interval = 100

$directories.Add_SelectedIndexChanged({ Update-InstallDirectoryStatus })

$search = {
    $status.Text = '正在搜索 Pengu Loader…'
    Start-InstallerJob 'Search' ''
}
$form.Add_Shown($search)
$searchButton.Add_Click($search)
$chooseButton.Add_Click({ Select-InstallDirectory })
$closeButton.Add_Click({ $form.Close() })

$installButton.Add_Click({
    if ($directories.SelectedIndex -lt 0) { Select-InstallFallback }
    $target = [string]$directories.SelectedItem
    if (-not $target) { return }
    if (Get-PenguDirectory $target) {
        $status.Text = '正在安装黑名单插件…'
        Start-InstallerJob 'Install' $target
        return
    }

    $status.Text = '正在下载并安装 Pengu Loader…'
    Start-InstallerJob 'Download' $target
})

$timer.Add_Tick({
    if ($script:canceledSearch -and $script:canceledSearch.Result.IsCompleted) {
        $script:canceledSearch.Worker.Dispose()
        $script:canceledSearch = $null
    }
    $running = $script:job
    if (-not $running) { return }
    if (-not $running.Result.IsCompleted) {
        if ($running.Action -eq 'Search' -and $running.Clock.ElapsedMilliseconds -ge 5000) {
            [void]$running.Worker.BeginStop($null, $null)
            $script:canceledSearch = $running
            $script:job = $null
            Set-InstallerBusy $false
            Select-InstallFallback
        }
        return
    }

    $script:job = $null
    Set-InstallerBusy $false
    try {
        $result = $running.Worker.EndInvoke($running.Result)
        if ($running.Action -eq 'Search') {
            if ($result.Count -eq 0) {
                Select-InstallFallback
                return
            }
            foreach ($path in $result) { Add-DirectoryChoice ([string]$path) }
            if (-not (Get-PenguDirectory ([string]$directories.SelectedItem))) {
                $directories.SelectedItem = [string]$result[0]
            }
            $status.Text = "找到 $($result.Count) 个 Pengu Loader 目录。"
            return
        }

        $installed = $result[0]
        $status.Text = '黑名单插件已安装。'
        if ($installed.NewPengu) {
            $message = "安装完成。请在 Pengu Loader 窗口点击「启用」，然后启动英雄联盟。`r`n`r`n现在打开 Pengu Loader 吗？"
            if ([Windows.Forms.MessageBox]::Show($form, $message, '安装完成', 'YesNo', 'Information') -eq 'Yes') {
                try {
                    Start-Process -FilePath (Join-Path $installed.Directory 'Pengu Loader.exe') -WorkingDirectory $installed.Directory -ErrorAction Stop
                } catch {
                    $message = "插件已安装，请从此目录手动打开 Pengu Loader。`r`n$($installed.Directory)"
                    [void][Windows.Forms.MessageBox]::Show($form, $message, '打开 Pengu Loader', 'OK', 'Information')
                }
            }
        } else {
            [void][Windows.Forms.MessageBox]::Show($form, '黑名单插件已安装。请重新启动英雄联盟客户端。', '安装完成')
        }
    } catch {
        if ($running.Action -eq 'Search') {
            Select-InstallFallback
            return
        }
        $status.Text = '操作未完成，可以重试或重新选择目录。'
        [void][Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, '安装黑名单', 'OK', 'Error')
    } finally {
        $running.Worker.Dispose()
    }
})

$form.Add_FormClosing({
    param($sender, $eventArgs)
    if ($script:job -and $script:job.Action -ne 'Search') {
        $eventArgs.Cancel = $true
        $form.DialogResult = 'None'
        $status.Text = '安装正在进行，请等候安装完成。'
    }
})

try {
    $timer.Start()
    [void]$form.ShowDialog()
} finally {
    $timer.Dispose()
    if ($script:job) { [void]$script:job.Worker.BeginStop($null, $null) }
    $form.Dispose()
}
