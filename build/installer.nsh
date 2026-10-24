; PS5 Game Launcher setup additions (electron-builder includes build/installer.nsh).
;
; An extra page after the install folder offers the programs some features
; need: HidHide and VIIPER for Controller in Games, OBS Studio for captures,
; yt-dlp for game theme music.
; Nothing is ticked by default and installed ones are greyed out. The ticked
; ones are downloaded and installed at the end of setup by deps.ps1; if a
; driver needs it, setup offers to restart Windows.
;
; Variables and functions live inside the page macro: electron-builder builds
; the uninstaller from the same script, and unused ones are errors there.

!include nsDialogs.nsh
!include LogicLib.nsh

!macro customPageAfterChangeDir
  Var ExtraHidHide
  Var ExtraViiper
  Var ExtraObs
  Var ExtraYtDlp
  Var ExtraBoxHidHide
  Var ExtraBoxViiper
  Var ExtraBoxObs
  Var ExtraBoxYtDlp

  Page custom ExtrasPageShow ExtrasPageLeave

  Function ExtrasPageShow
    ${if} ${isUpdated}
      Abort
    ${endif}
    !insertmacro MUI_HEADER_TEXT "Extras" "Programs that some features of ${PRODUCT_NAME} need."
    nsDialogs::Create 1018
    Pop $0
    ${if} $0 == error
      Abort
    ${endif}

    ${NSD_CreateLabel} 0 0 100% 20u "Tick what you'd like installed. Each one is downloaded from its official GitHub page at the end of setup, so an internet connection is needed."
    Pop $0

    ${NSD_CreateCheckbox} 0 22u 100% 11u "HidHide - hides your real controller from games"
    Pop $ExtraBoxHidHide
    ${NSD_CreateLabel} 13u 33u -13u 10u "For Controller in Games (no double input). Installs a driver."
    Pop $0

    ${NSD_CreateCheckbox} 0 46u 100% 11u "VIIPER - the virtual controller games see (with USBIP)"
    Pop $ExtraBoxViiper
    ${NSD_CreateLabel} 13u 57u -13u 10u "For Controller in Games. Starts with Windows. Installs a driver."
    Pop $0

    ${NSD_CreateCheckbox} 0 70u 100% 11u "OBS Studio - records clips, screenshots and gameplay"
    Pop $ExtraBoxObs
    ${NSD_CreateLabel} 13u 81u -13u 10u "For Settings > Captures. Runs hidden in the background while you play."
    Pop $0

    ${NSD_CreateCheckbox} 0 94u 100% 11u "yt-dlp - game theme music from YouTube"
    Pop $ExtraBoxYtDlp
    ${NSD_CreateLabel} 13u 105u -13u 10u "For Settings > Sound > Game Theme Music. A small program, no driver."
    Pop $0

    ${NSD_CreateLabel} 0 120u 100% 20u "Windows asks for permission to install drivers, and a restart may be needed afterwards. You can also install these later (User Guide > Controller in Games, Settings > Sound)."
    Pop $0

    ; Already installed: listed, but there is nothing to do.
    ReadRegStr $1 HKLM "SYSTEM\CurrentControlSet\Services\HidHide" "ImagePath"
    ${if} $1 != ""
      ${NSD_SetText} $ExtraBoxHidHide "HidHide - already installed"
      EnableWindow $ExtraBoxHidHide 0
    ${elseif} $ExtraHidHide == ${BST_CHECKED}
      ${NSD_Check} $ExtraBoxHidHide
    ${endif}

    ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VIIPER" "DisplayVersion"
    ${if} $1 != ""
      ${NSD_SetText} $ExtraBoxViiper "VIIPER - already installed"
      EnableWindow $ExtraBoxViiper 0
    ${elseif} $ExtraViiper == ${BST_CHECKED}
      ${NSD_Check} $ExtraBoxViiper
    ${endif}

    ReadRegStr $1 HKLM "SOFTWARE\OBS Studio" ""
    ${if} $1 == ""
      SetRegView 32
      ReadRegStr $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\OBS Studio" "DisplayVersion"
      SetRegView 64
    ${endif}
    ${if} $1 != ""
      ${NSD_SetText} $ExtraBoxObs "OBS Studio - already installed"
      EnableWindow $ExtraBoxObs 0
    ${elseif} $ExtraObs == ${BST_CHECKED}
      ${NSD_Check} $ExtraBoxObs
    ${endif}

    ; yt-dlp lives in the launcher's data folder (main/ytdlp.js).
    ${if} ${FileExists} "$APPDATA\${PRODUCT_NAME}\tools\yt-dlp.exe"
      ${NSD_SetText} $ExtraBoxYtDlp "yt-dlp - already installed"
      EnableWindow $ExtraBoxYtDlp 0
    ${elseif} $ExtraYtDlp == ${BST_CHECKED}
      ${NSD_Check} $ExtraBoxYtDlp
    ${endif}

    nsDialogs::Show
  FunctionEnd

  Function ExtrasPageLeave
    ${NSD_GetState} $ExtraBoxHidHide $ExtraHidHide
    ${NSD_GetState} $ExtraBoxViiper $ExtraViiper
    ${NSD_GetState} $ExtraBoxObs $ExtraObs
    ${NSD_GetState} $ExtraBoxYtDlp $ExtraYtDlp
  FunctionEnd
!macroend

!macro customInstall
  StrCpy $R0 ""
  ${if} $ExtraHidHide == ${BST_CHECKED}
    StrCpy $R0 "$R0 -HidHide"
  ${endif}
  ${if} $ExtraViiper == ${BST_CHECKED}
    StrCpy $R0 "$R0 -Viiper"
  ${endif}
  ${if} $ExtraObs == ${BST_CHECKED}
    StrCpy $R0 "$R0 -Obs"
  ${endif}
  ${if} $ExtraYtDlp == ${BST_CHECKED}
    StrCpy $R0 '$R0 -YtDlp -ToolsDir "$APPDATA\${PRODUCT_NAME}\tools"'
  ${endif}
  ${if} $R0 != ""
    InitPluginsDir
    File "/oname=$PLUGINSDIR\deps.ps1" "${BUILD_RESOURCES_DIR}\deps.ps1"
    DetailPrint "Installing extras..."
    ; 64-bit PowerShell (this setup program itself is 32-bit).
    StrCpy $R1 "$WINDIR\SysNative\WindowsPowerShell\v1.0\powershell.exe"
    ${ifNot} ${FileExists} "$R1"
      StrCpy $R1 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
    ${endif}
    nsExec::ExecToLog '"$R1" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\deps.ps1"$R0'
    Pop $R2
    ; deps.ps1 exit code: bit 1 = something failed, bit 2 = restart needed
    ${if} $R2 == "error"
    ${orIf} $R2 == "timeout"
      StrCpy $R2 1
    ${endif}
    IntOp $R3 $R2 & 1
    ${if} $R3 <> 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "Some extras couldn't be installed (Show details lists why). You can install them later: User Guide > Controller in Games, or Settings > Sound for yt-dlp." /SD IDOK
    ${endif}
    IntOp $R3 $R2 & 2
    ${if} $R3 <> 0
      MessageBox MB_YESNO|MB_ICONQUESTION "Windows needs a restart to finish installing the controller drivers.$\r$\n$\r$\nRestart now?" /SD IDNO IDNO +2
      Reboot
    ${endif}
  ${endif}
!macroend
