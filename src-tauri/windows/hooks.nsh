; Adopt the previous per-user install location when the displayed product name changes.
; The binary, bundle identifier, application data and updater trust key stay unchanged.
!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R7 HKCU "Software\freddyjd\factory" ""
  ${If} $R7 == ""
    ReadRegStr $R8 HKCU "Software\freddyjd\Git Factory" ""
    ReadRegStr $R9 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Git Factory" "MainBinaryName"
    ${If} $R8 != ""
    ${AndIf} $R9 == "git-factory.exe"
      IfFileExists "$R8\git-factory.exe" 0 +3
        StrCpy $INSTDIR $R8
        SetOutPath $INSTDIR
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R8 HKCU "Software\freddyjd\Git Factory" ""
  ${If} $R8 == $INSTDIR
    ReadRegStr $R9 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Git Factory" "MainBinaryName"
    ${If} $R9 == "git-factory.exe"
      !insertmacro IsShortcutTarget "$DESKTOP\Git Factory.lnk" "$INSTDIR\git-factory.exe"
      Pop $R7
      ${If} $R7 = 1
        Delete "$DESKTOP\Git Factory.lnk"
        CreateShortcut "$DESKTOP\factory.lnk" "$INSTDIR\git-factory.exe"
      ${EndIf}
      !insertmacro IsShortcutTarget "$SMPROGRAMS\Git Factory.lnk" "$INSTDIR\git-factory.exe"
      Pop $R7
      ${If} $R7 = 1
        Delete "$SMPROGRAMS\Git Factory.lnk"
        CreateShortcut "$SMPROGRAMS\factory.lnk" "$INSTDIR\git-factory.exe"
      ${EndIf}
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Git Factory"
      DeleteRegKey HKCU "Software\freddyjd\Git Factory"
    ${EndIf}
  ${EndIf}
!macroend
