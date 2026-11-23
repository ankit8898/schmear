#include "store.h"

#include <QDateTime>

#include "cli.h"

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

const Snapshot *Store::snapshot() const
{
    return m_snapshot ? &*m_snapshot : nullptr;
}

QString Store::error() const
{
    return m_error;
}

bool Store::refreshing() const
{
    return m_refreshing;
}

double Store::now() const
{
    return m_now;
}
