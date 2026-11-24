#include "theme.h"

#include <QImage>
#include <QPainter>
#include <QtTest>

class TestTheme : public QObject {
    Q_OBJECT
private slots:
    void fillsTheTopLayer_data()
    {
        QTest::addColumn<bool>("dark");
        QTest::newRow("light") << false;
        QTest::newRow("dark") << true;
    }
    void fillsTheTopLayer()
    {
        QFETCH(bool, dark);
        const QPalette p = reviewPalette(dark);
        const QColor fill = p.color(QPalette::Highlight);
        QCOMPARE(trayPixmap(true, 0, p).toImage().pixelColor(32, 19), fill);
        QVERIFY(trayPixmap(false, 0, p).toImage().pixelColor(32, 19) != fill);
    }

    void drawsTheBadge_data() { fillsTheTopLayer_data(); }
    void drawsTheBadge()
    {
        QFETCH(bool, dark);
        const QPalette p = reviewPalette(dark);
        QCOMPARE(trayPixmap(false, 3, p).toImage().pixelColor(61, 48), p.color(QPalette::Highlight));
        QCOMPARE(trayPixmap(false, 0, p).toImage().pixelColor(61, 48).alpha(), 0);
    }

    void attentionDrawsOutlinedWithBadge_data() { fillsTheTopLayer_data(); }
    void attentionDrawsOutlinedWithBadge()
    {
        QFETCH(bool, dark);
        const QPalette p = reviewPalette(dark);
        const QImage plain = trayPixmap(false, 0, p, false).toImage();
        const QImage attn = trayPixmap(false, 0, p, true).toImage();
        const QImage attnOverFilled = trayPixmap(true, 3, p, true).toImage();
        QVERIFY(attn != plain);
        QCOMPARE(attnOverFilled, attn);
        QVERIFY(attnOverFilled.pixelColor(32, 19) != p.color(QPalette::Highlight));
        QCOMPARE(attnOverFilled.pixelColor(61, 48), Orange);
    }

    void is64Square_data() { fillsTheTopLayer_data(); }
    void is64Square()
    {
        QFETCH(bool, dark);
        const QPixmap pm = trayPixmap(true, 12, reviewPalette(dark));
        QCOMPARE(pm.size(), QSize(64, 64));
        QCOMPARE(pm.devicePixelRatio(), 1.0);
    }

    // Visual check of the glyph at panel sizes on light and dark panels; written only when asked for.
    void iconSheet()
    {
        const QString path = qEnvironmentVariable("SCHMEAR_ICON_SHEET");
        if (path.isEmpty())
            QSKIP("SCHMEAR_ICON_SHEET not set");
        const QPalette light = reviewPalette(false), dark = reviewPalette(true);
        const QList<QPixmap> icons{trayPixmap(false, 0, light), trayPixmap(true, 3, light), trayPixmap(false, 0, light, true),
                                   trayPixmap(false, 0, dark), trayPixmap(true, 12, dark), trayPixmap(false, 0, dark, true)};
        const int gap = 8, small = 22, row = 64 + gap;
        QImage sheet(gap + icons.size() * (64 + gap) + icons.size() * (small + gap), gap + 2 * row,
                     QImage::Format_ARGB32);
        QPainter g(&sheet);
        g.setRenderHint(QPainter::SmoothPixmapTransform);
        const QList<QColor> panels{QColor("#f2f2f2"), QColor("#1e1e1e")};
        for (int r = 0; r < panels.size(); ++r) {
            const int y = gap + r * row;
            g.fillRect(0, y - gap, sheet.width(), row + (r == panels.size() - 1 ? gap : 0), panels[r]);
            int x = gap;
            for (const QPixmap &icon : icons) {
                g.drawPixmap(x, y, icon);
                x += 64 + gap;
            }
            for (const QPixmap &icon : icons) {
                g.drawPixmap(x, y + (64 - small) / 2,
                             icon.scaled(small, small, Qt::IgnoreAspectRatio, Qt::SmoothTransformation));
                x += small + gap;
            }
        }
        g.end();
        QVERIFY2(sheet.save(path), qPrintable(path));
    }
};

QTEST_MAIN(TestTheme)
#include "tst_theme.moc"
