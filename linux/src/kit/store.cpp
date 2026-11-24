#include "store.h"

#include <QDateTime>

#include "cli.h"
#include "format.h"

static double currentTime()
{
    return QDateTime::currentMSecsSinceEpoch() / 1000.0;
}

Store::Store(QObject *parent) : QObject(parent), m_now(currentTime())
{
}

Store::Store(Snapshot snapshot, double now, QObject *parent) : QObject(parent), m_snapshot(std::move(snapshot)), m_now(now)
{
}

void Store::start()
{
    connect(&m_timer, &QTimer::timeout, this, &Store::refresh);
    m_timer.start(60 * 1000);
    refresh();
}

void Store::refresh()
{
    m_now = currentTime();
    if (m_refreshing) {
        emit changed();
        return;
    }
    m_refreshing = true;
    emit changed();
    Cli::run({QStringLiteral("usage"), QStringLiteral("--json")}, {}, this, [this](const Reply &reply) {
        m_notInstalled = reply.status == Reply::NotInstalled;
        if (reply.status == Reply::Ok) {
            QString error;
            if (auto snapshot = decodeSnapshot(reply.out, &error)) {
                m_snapshot = std::move(snapshot);
                m_error.clear();
            } else {
                m_error = error;
            }
        } else {
            if (reply.status == Reply::NotInstalled)
                m_snapshot.reset();
            m_error = reply.error;
        }
        m_refreshing = false;
        m_now = currentTime();
        emit changed();
    });
}

void Store::reconnect()
{
    if (m_reconnecting)
        return;
    const QStringList names = m_snapshot ? Format::disconnectedHosts(*m_snapshot) : QStringList{};
    m_reconnecting = true;
    m_reconnectError.clear();
    m_reconnectHint.clear();
    emit changed();
    Cli::run({QStringLiteral("init"), QStringLiteral("--yes")}, {}, this, [this, names](const Reply &reply) {
        m_reconnecting = false;
        if (reply.status == Reply::Ok) {
            m_reconnectError.clear();
            m_reconnectHint = names.isEmpty()
                ? QStringLiteral("Reconnected. Restart your agents to use schmear.")
                : QStringLiteral("Reconnected. Restart %1 to use schmear.").arg(names.join(QStringLiteral(", ")));
            refresh();
        } else {
            m_reconnectError = reply.error;
            emit changed();
        }
    });
}

void Store::dismissReconnectHint()
{
    if (m_reconnectHint.isEmpty())
        return;
    m_reconnectHint.clear();
    emit changed();
}

const Snapshot *Store::snapshot() const
{
    return m_snapshot ? &*m_snapshot : nullptr;
}

QString Store::error() const
{
    return m_error;
}

bool Store::notInstalled() const
{
    return m_notInstalled;
}

bool Store::refreshing() const
{
    return m_refreshing;
}

bool Store::reconnecting() const
{
    return m_reconnecting;
}

QString Store::reconnectError() const
{
    return m_reconnectError;
}

QString Store::reconnectHint() const
{
    return m_reconnectHint;
}

double Store::now() const
{
    return m_now;
}
