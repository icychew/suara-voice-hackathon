param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$pauseSynth = $null
$pauseStream = $null
try {
    Add-Type -AssemblyName System.Speech
    $pauseSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $pauseSynth.SelectVoice('Microsoft Zira Desktop')
    $pauseSynth.Rate = 0
    $pauseSynth.Volume = 100
    $pauseFormat = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
        24000,
        [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
        [System.Speech.AudioFormat.AudioChannel]::Mono
    )
    $pausePhrases = @(
        'When I was young, the place I remember most was',
        'a yellow bridge beside the river, where my neighbors waved to me.'
    )
    $pauseClauses = @()
    foreach ($pausePhrase in $pausePhrases) {
        $pauseStream = New-Object System.IO.MemoryStream
        $pauseSynth.SetOutputToAudioStream($pauseStream, $pauseFormat)
        $pauseSynth.Speak($pausePhrase)
        $pauseSynth.SetOutputToNull()
        $pauseClauses += [Convert]::ToBase64String($pauseStream.ToArray())
        $pauseStream.Dispose()
        $pauseStream = $null
    }
    # Caller captures this fictional fixture in memory; no speaker or file output.
    @{ sampleRate = 24000; clauses = $pauseClauses } | ConvertTo-Json -Compress
} catch {
    Write-Output '{"error":"Fictional speech synthesis unavailable."}'
    exit 1
} finally {
    if ($null -ne $pauseStream) { $pauseStream.Dispose() }
    if ($null -ne $pauseSynth) { $pauseSynth.Dispose() }
}
