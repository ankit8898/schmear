#pragma once

#include <QLocalServer>
#include <QString>

namespace Desktop {

QString autostartPath();
// The file exists and has no `Hidden=true` line, which desktops write to disable an entry.
bool autostartEnabled(const QString &path);
// Empty on success, else the message to show.
QString setAutostart(const QString &path, bool on, const QString &executable);

QString instancePath();
enum class Claim { First, Running, Failed };
// Running: a live instance accepted a connection (it shows its window). First: server listens at path.
// Failed: listen failed; server.errorString() says why.
Claim claimInstance(QLocalServer &server, const QString &path);

}
