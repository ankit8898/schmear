#include "desktop.h"

#include <QFile>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QtTest>

class TestDesktop : public QObject {
    Q_OBJECT
private slots:
    void autostart()
    {
        QTemporaryDir dir;
        const QString path = dir.path() + "/autostart/schmear-tray.desktop";
        const QString exe = "/opt/my apps/schmear-tray";
        QVERIFY(!Desktop::autostartEnabled(path));

        QCOMPARE(Desktop::setAutostart(path, true, exe), QString());
        QFile f(path);
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QByteArray written = f.readAll();
        f.close();
        QCOMPARE(written, QByteArray("[Desktop Entry]\n"
                                     "Type=Application\n"
                                     "Name=schmear\n"
                                     "Exec=\"/opt/my apps/schmear-tray\"\n"
                                     "Icon=schmear-tray\n"
                                     "Terminal=false\n"));
        QVERIFY(Desktop::autostartEnabled(path));

        QVERIFY(f.open(QIODevice::WriteOnly | QIODevice::Truncate));
        f.write(QByteArray(written).replace("Terminal=false", "Hidden=true"));
        f.close();
        QVERIFY(!Desktop::autostartEnabled(path));

        QCOMPARE(Desktop::setAutostart(path, false, exe), QString());
        QVERIFY(!QFile::exists(path));
        QCOMPARE(Desktop::setAutostart(path, false, exe), QString());
    }

    void autostartRefusesUnsafePath()
    {
        QTemporaryDir dir;
        const QString path = dir.path() + "/autostart/schmear-tray.desktop";
        QCOMPARE(Desktop::setAutostart(path, true, "/opt/$x/schmear-tray"),
                 QString("Open at Login needs a path without quotes, backslashes, $, backticks, % or line breaks: /opt/$x/schmear-tray"));
        QVERIFY(!QFile::exists(path));
    }

    void instance()
    {
        QTemporaryDir dir;
        const QString path = dir.path() + "/schmear-tray.sock";
        QLocalServer first;
        QCOMPARE(Desktop::claimInstance(first, path), Desktop::Claim::First);

        QSignalSpy connected(&first, &QLocalServer::newConnection);
        QLocalServer second;
        QCOMPARE(Desktop::claimInstance(second, path), Desktop::Claim::Running);
        QVERIFY(connected.wait(5000));

        first.close();
        QLocalServer third;
        QCOMPARE(Desktop::claimInstance(third, path), Desktop::Claim::First);
    }
};

QTEST_MAIN(TestDesktop)
#include "tst_desktop.moc"
