; Registers Slash as a browser Windows is willing to offer as the default.
;
; This is the half of "make Slash your default browser" that has to happen at
; install time. Windows will not let an application make itself the default —
; the association lives in a UserChoice key signed with a hash tied to the user
; and the ProgId, and writing it from code is a supported-configuration
; violation Windows silently reverts. What an installer *can* do is register the
; application so it appears in Settings → Default apps, which is where the user
; makes the choice themselves.
;
; Without these keys, the in-app "Make Slash my default" button would open a
; list Slash is not in — worse than not offering at all.
;
; HKCU throughout, matching `perMachine: false` in electron-builder.yml. A
; per-machine install would want the same keys under HKLM; changing one without
; the other leaves the entry pointing at nothing.
;
; The ProgId must stay in step with SLASH_PROGID in
; src/main/system/defaultBrowserRules.ts. A mismatch fails silently.

!macro customInstall
  ; --- the ProgId: what actually opens a page -------------------------------
  WriteRegStr HKCU "Software\Classes\SlashHTM" "" "Slash HTML Document"
  WriteRegStr HKCU "Software\Classes\SlashHTM\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\SlashHTM\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; --- the application entry Windows lists ----------------------------------
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Slash" "" "Slash"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Slash\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Slash\shell\open\command" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"

  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Slash\Capabilities" "ApplicationName" "Slash"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Slash\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Slash\Capabilities" "ApplicationDescription" "A browser that organises what you have open and keeps what it learns on this machine."

  ; Windows shows a browser per association, so all four are declared. Slash
  ; genuinely handles each of them: http/https through the omnibox, and local
  ; HTML through the same argv path.
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Slash\Capabilities\URLAssociations" "http" "SlashHTM"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Slash\Capabilities\URLAssociations" "https" "SlashHTM"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Slash\Capabilities\FileAssociations" ".htm" "SlashHTM"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Slash\Capabilities\FileAssociations" ".html" "SlashHTM"

  ; The pointer that makes the capabilities above visible to Settings.
  WriteRegStr HKCU "Software\RegisteredApplications" "Slash" "Software\Clients\StartMenuInternet\Slash\Capabilities"
!macroend

!macro customUnInstall
  ; Left behind, an entry in Default apps points at a deleted executable and the
  ; user cannot remove it from the Settings screen.
  DeleteRegKey HKCU "Software\Classes\SlashHTM"
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Slash"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Slash"
!macroend
