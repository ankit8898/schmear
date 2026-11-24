#include "desktop.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QLocalSocket>
#include <QRegularExpression>
#include <QSaveFile>
#include <QStandardPaths>

namespace Desktop {

QString autostartPath()
{
    return QStandardPaths::writableLocation(QStandardPaths::GenericConfigLocation)
        + QStringLiteral("/autostart/schmear-tray.desktop");
}

bool autostartEnabled(const QString &path)
{
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly))
        return false;
    static const QRegularExpression hidden(QStringLiteral("^Hidden\\s*=\\s*true\\s*$"),
                                           QRegularExpression::MultilineOption);
    return !hidden.match(QString::fromUtf8(f.readAll())).hasMatch();
}

// Refusing these characters means Exec="…" needs no escaping.
static bool execSafe(const QString &executable)
{
    for (const QChar c : executable) {
        if (c == u'"' || c == u'`' || c == u'$' || c == u'\\' || c == u'%' || c.unicode() < 0x20 || c.unicode() == 0x7f)
            return false;
    }
    return true;
}

QString setAutostart(const QString &path, bool on, const QString &executable)
{
    if (!on) {
        QFile f(path);
        if (f.exists() && !f.remove())
            return QStringLiteral("Could not remove %1: %2").arg(path, f.errorString());
        return {};
    }
    if (!execSafe(executable))
        return QStringLiteral("Open at Login needs a path without quotes, backslashes, $, backticks, % or line breaks: %1").arg(executable);
    QDir().mkpath(QFileInfo(path).absolutePath());
    QSaveFile f(path);
    if (f.open(QIODevice::WriteOnly)) {
        f.write(QStringLiteral("[Desktop Entry]\n"
                               "Type=Application\n"
                               "Name=schmear\n"
                               "Exec=\"%1\" --autostart\n"
                               "Icon=schmear-tray\n"
                               "Terminal=false\n").arg(executable).toUtf8());
        if (f.commit())
            return {};
    }
    return QStringLiteral("Could not write %1: %2").arg(path, f.errorString());
}

QString instancePath()
{
    return QStandardPaths::writableLocation(QStandardPaths::RuntimeLocation)
        + QStringLiteral("/schmear-tray.sock");
}

Claim claimInstance(QLocalServer &server, const QString &path)
{
    QLocalSocket socket;
    socket.connectToServer(path);
    if (socket.waitForConnected(500)) {
        socket.disconnectFromServer();
        return Claim::Running;
    }
    QLocalServer::removeServer(path);
    server.setSocketOptions(QLocalServer::UserAccessOption);
    return server.listen(path) ? Claim::First : Claim::Failed;
}

}
