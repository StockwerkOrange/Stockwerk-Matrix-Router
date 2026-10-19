// Stockwerk Matrix Router – Windows starter.
// Starts "dotnet StockwerkMatrixRouter.dll" next to this exe without a console window.
// Build: see README ("Selbst bauen").
#include <windows.h>
#include <shellapi.h>
#include <wchar.h>

static const wchar_t *TITLE = L"Stockwerk Matrix Router";
static const wchar_t *DOWNLOAD = L"https://dotnet.microsoft.com/download/dotnet/8.0";

static int findDotnet(wchar_t *out, DWORD n) {
    if (SearchPathW(NULL, L"dotnet.exe", NULL, n, out, NULL)) return 1;
    wchar_t pf[MAX_PATH];
    if (GetEnvironmentVariableW(L"ProgramFiles", pf, MAX_PATH)) {
        swprintf(out, n, L"%ls\\dotnet\\dotnet.exe", pf);
        if (GetFileAttributesW(out) != INVALID_FILE_ATTRIBUTES) return 1;
    }
    return 0;
}

static void askRuntime(const wchar_t *why) {
    wchar_t msg[600];
    swprintf(msg, 600, L"%ls\n\nDer Router braucht die kostenlose .NET 8 Runtime von Microsoft. Download-Seite jetzt öffnen?", why);
    if (MessageBoxW(NULL, msg, TITLE, MB_YESNO | MB_ICONINFORMATION) == IDYES)
        ShellExecuteW(NULL, L"open", DOWNLOAD, NULL, NULL, SW_SHOWNORMAL);
}

int WINAPI wWinMain(HINSTANCE h, HINSTANCE p, LPWSTR args, int show) {
    wchar_t dir[MAX_PATH], dll[MAX_PATH], dotnet[MAX_PATH], cmd[3 * MAX_PATH + 64];
    GetModuleFileNameW(NULL, dir, MAX_PATH);
    wchar_t *slash = wcsrchr(dir, L'\\');
    if (slash) *slash = 0;
    swprintf(dll, MAX_PATH, L"%ls\\StockwerkMatrixRouter.dll", dir);
    if (GetFileAttributesW(dll) == INVALID_FILE_ATTRIBUTES) {
        MessageBoxW(NULL, L"StockwerkMatrixRouter.dll fehlt. Bitte den ganzen Ordner aus dem ZIP entpacken, nicht nur die .exe.", TITLE, MB_ICONERROR);
        return 1;
    }
    if (!findDotnet(dotnet, MAX_PATH)) { askRuntime(L".NET wurde auf diesem Rechner nicht gefunden."); return 1; }

    swprintf(cmd, sizeof cmd / sizeof *cmd, L"\"%ls\" \"%ls\" %ls", dotnet, dll, args);
    STARTUPINFOW si = { sizeof si };
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, dir, &si, &pi)) {
        MessageBoxW(NULL, L"Der Router konnte nicht gestartet werden.", TITLE, MB_ICONERROR);
        return 1;
    }
    // A quick non-zero exit means the runtime is missing or too old. Exit 0 = second start, window opened.
    if (WaitForSingleObject(pi.hProcess, 4000) == WAIT_OBJECT_0) {
        DWORD code = 0;
        GetExitCodeProcess(pi.hProcess, &code);
        if (code != 0) askRuntime(L"Der Router hat sich sofort beendet – meist fehlt die .NET 8 Runtime.");
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 0;
}
