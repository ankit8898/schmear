#include <QApplication>
#include <QFile>
#include <QImage>
#include <QLayout>
#include <QPainter>
#include <QStyleFactory>
#include <cstdio>

#include "models.h"
#include "popover.h"
#include "store.h"
#include "theme.h"

static void fail(const QString &message)
{
    std::fprintf(stderr, "schmear-tray: %s\n", qPrintable(message));
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
    if (mode != QLatin1String("--render")) {
        fail(QStringLiteral("--render-tiers is not built yet"));
        return 1;
    }
    QFile file(paths[0]);
    if (!file.open(QIODevice::ReadOnly)) {
        fail(QStringLiteral("cannot read %1: %2").arg(paths[0], file.errorString()));
        return 1;
    }
    QString error;
    const auto snapshot = decodeSnapshot(file.readAll(), &error);
    if (!snapshot) {
        fail(error);
        return 1;
    }
    Store store(*snapshot, snapshot->at / 1000 + 120);
    PopoverWindow popover(&store, false);
    return renderWidget(popover, 360, paths[1]);
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

    Store store;
    PopoverWindow popover(&store, true);
    popover.show();
    store.start();
    return app.exec();
}
