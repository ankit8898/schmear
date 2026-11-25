#include <QApplication>
#include <QDBusConnection>
#include <QDBusMessage>
#include <QDBusVariant>
#include <QFile>
#include <QImage>
#include <QLayout>
#include <QLocalServer>
#include <QLocalSocket>
#include <QMenu>
#include <QPainter>
#include <QScreen>
#include <QSettings>
#include <QStyleFactory>
#include <QSystemTrayIcon>
#include <QTimer>
#include <algorithm>
#include <optional>
#include <cstdio>

#include "desktop.h"
#include "format.h"
#include "models.h"
#include "popover.h"
#include "store.h"
#include "theme.h"
#include "tiereditor.h"

static void fail(const QString &message)
{
    std::fprintf(stderr, "schmear-tray: %s\n", qPrintable(message));
}

// The panel's tray host, which a StatusNotifierItem tray icon needs.
static bool trayHostRegistered()
{
    QDBusMessage get = QDBusMessage::createMethodCall(
        QStringLiteral("org.kde.StatusNotifierWatcher"), QStringLiteral("/StatusNotifierWatcher"),
        QStringLiteral("org.freedesktop.DBus.Properties"), QStringLiteral("Get"));
    get << QStringLiteral("org.kde.StatusNotifierWatcher") << QStringLiteral("IsStatusNotifierHostRegistered");
    const QDBusMessage reply = QDBusConnection::sessionBus().call(get, QDBus::Block, 1000);
    return reply.type() == QDBusMessage::ReplyMessage
        && reply.arguments().value(0).value<QDBusVariant>().variant().toBool();
}

// Review-only: draws the widget at width as a 2x PNG.
static int renderWidget(QWidget &widget, int width, const QString &path)
{
    widget.setFixedWidth(width);
    widget.adjustSize();
    if (widget.layout()->hasHeightForWidth())
        widget.resize(width, widget.layout()->totalHeightForWidth(width));
    QImage image(widget.size() * 2, QImage::Format_ARGB32);
    image.setDevicePixelRatio(2);
    image.fill(widget.palette().color(QPalette::Window));
    QPainter painter(&image);
    widget.render(&painter);
    painter.end();
    if (!image.save(path)) {
        fail(QStringLiteral("cannot write ") + path);
        return 1;
    }
    return 0;
}

static int render(const QString &mode, QStringList paths)
{
    const bool dark = paths.removeAll(QStringLiteral("--dark")) > 0;
    if (paths.size() != 2) {
        const char *input = mode == QLatin1String("--render") ? "<snapshot.json>" : "<tiers.json>";
        std::fprintf(stderr, "usage: schmear-tray %s %s <out.png> [--dark]\n", qPrintable(mode), input);
        return 2;
    }
    QApplication::setStyle(QStyleFactory::create(QStringLiteral("Fusion")));
    QApplication::setPalette(reviewPalette(dark));
    QFile file(paths[0]);
    if (!file.open(QIODevice::ReadOnly)) {
        fail(QStringLiteral("cannot read %1: %2").arg(paths[0], file.errorString()));
        return 1;
    }
    const QByteArray json = file.readAll();
    QString error;
    if (mode == QLatin1String("--render")) {
        const auto snapshot = decodeSnapshot(json, &error);
        if (!snapshot) {
            fail(error);
            return 1;
        }
        Store store(*snapshot, snapshot->at / 1000 + 120);
        PopoverWindow popover(&store, false);
        return renderWidget(popover, 360, paths[1]);
    }
    const auto doc = decodeTiers(json, &error);
    if (!doc) {
        fail(error);
        return 1;
    }
    Store store;
    TierEditor editor(&store, false);
    editor.setDoc(*doc);
    return renderWidget(editor, 560, paths[1]);
}

int main(int argc, char *argv[])
{
    QApplication app(argc, argv);
    QApplication::setApplicationName(QStringLiteral("schmear-tray"));
    QGuiApplication::setDesktopFileName(QStringLiteral("schmear-tray"));

    const QStringList args = app.arguments();
    const QString mode = args.value(1);
    if (mode == QLatin1String("--render") || mode == QLatin1String("--render-tiers"))
        return render(mode, args.mid(2));

    QLocalServer server;
    switch (Desktop::claimInstance(server, Desktop::instancePath())) {
    case Desktop::Claim::Running:
        return 0;
    case Desktop::Claim::Failed:
        fail(server.errorString());
        return 1;
    case Desktop::Claim::First:
        break;
    }

    Store store;
    PopoverWindow popover(&store, true);
    TierEditor editor(&store, true);
    QObject::connect(&popover, &PopoverWindow::editTiersRequested, &editor, &TierEditor::present);
    QApplication::setWindowIcon(QIcon(trayPixmap(false, 0, app.palette())));
    std::optional<QSystemTrayIcon> tray;

    const auto showPopover = [&] {
        const QRect g = tray ? tray->geometry() : QRect();
        if (!g.isEmpty()) {
            QScreen *screen = QGuiApplication::screenAt(g.center());
            const QRect a = (screen ? screen : QGuiApplication::primaryScreen())->availableGeometry();
            const int w = popover.width(), h = popover.height();
            const int x = std::clamp(g.center().x() - w / 2, a.left(), std::max(a.left(), a.right() - w + 1));
            const int y = g.center().y() < a.center().y() ? g.bottom() + 4 : g.top() - h - 4;
            popover.move(x, std::clamp(y, a.top(), std::max(a.top(), a.bottom() - h + 1)));
        }
        popover.show();
        popover.raise();
        popover.activateWindow();
    };
    QObject::connect(&server, &QLocalServer::newConnection, [&] {
        server.nextPendingConnection()->deleteLater();
        showPopover();
    });

    QMenu menu;
    const auto start = [&] {
        if (QSystemTrayIcon::isSystemTrayAvailable()) {
            tray.emplace();
            menu.addAction(QStringLiteral("Open schmear"), showPopover);
            menu.addSeparator();
            menu.addAction(QStringLiteral("Quit"), &app, &QCoreApplication::quit);
            tray->setContextMenu(&menu);
            QObject::connect(&*tray, &QSystemTrayIcon::activated, [&](QSystemTrayIcon::ActivationReason reason) {
                if (reason != QSystemTrayIcon::Trigger)
                    return;
                if (popover.isVisible() && !popover.isMinimized())
                    popover.hide();
                else
                    showPopover();
            });
            const auto updateTray = [&] {
                const Snapshot *s = store.snapshot();
                const bool needsAttention = Format::attention(s, store.notInstalled());
                tray->setIcon(QIcon(trayPixmap(Format::underspent(s), Format::runningCount(s),
                                              app.palette(), needsAttention)));
                tray->setToolTip(Format::trayLabel(s, store.notInstalled()));
            };
            // Posted ids persist so a notice shows once across launches.
            const auto postNotices = [&] {
                const Snapshot *s = store.snapshot();
                if (!s)
                    return;
                QSettings settings(QStringLiteral("schmear"), QStringLiteral("schmear-tray"));
                QStringList posted = settings.value(QStringLiteral("postedNotices")).toStringList();
                for (const auto &notice : Format::unposted(*s, &posted))
                    tray->showMessage(notice.title, notice.body);
                settings.setValue(QStringLiteral("postedNotices"), posted);
            };
            QObject::connect(&store, &Store::changed, &*tray, updateTray);
            QObject::connect(&store, &Store::changed, &*tray, postNotices);
            updateTray();
            postNotices();
            tray->show();
            QApplication::setQuitOnLastWindowClosed(false);
        } else {
            QApplication::setQuitOnLastWindowClosed(true);
            popover.setNotice(QStringLiteral("No system tray found, so schmear runs as a window and closing it quits. "
                                             "On GNOME, install the AppIndicator extension."));
            popover.show();
        }
    };

    // At login the panel may start after this app, and Qt 6.4 (and later, at least to 6.6) decides once per process, at the first
    // QSystemTrayIcon, whether a tray exists; so an autostart waits up to a minute for the panel's tray host.
    QTimer wait;
    int waitsLeft = args.contains(QLatin1String("--autostart")) ? 60 : 0;
    QObject::connect(&wait, &QTimer::timeout, [&] {
        if (--waitsLeft > 0 && !trayHostRegistered())
            return;
        wait.stop();
        start();
    });
    if (waitsLeft > 0 && !trayHostRegistered()) {
        // A window opened during the wait, by launching again, must not end the app when closed.
        QApplication::setQuitOnLastWindowClosed(false);
        wait.start(1000);
    } else
        start();

    store.start();
    return app.exec();
}
