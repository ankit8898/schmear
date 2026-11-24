#include "theme.h"

#include <QFont>
#include <QPainter>
#include <QPainterPath>
#include <QPolygonF>

QColor secondary(const QPalette &p)
{
    QColor c = p.color(QPalette::WindowText);
    c.setAlpha(150);
    return c;
}

QColor lineColor(const QPalette &p)
{
    QColor c = p.color(QPalette::WindowText);
    c.setAlpha(38);
    return c;
}

QPalette reviewPalette(bool dark)
{
    QPalette p = dark ? QPalette(QColor("#2d2d2d"), QColor("#1e1e1e")) : QPalette(QColor("#efefef"), QColor("#efefef"));
    const QColor text(dark ? "#e6e6e6" : "#000000");
    for (auto role : {QPalette::WindowText, QPalette::Text, QPalette::ButtonText})
        p.setColor(role, text);
    p.setColor(QPalette::Base, QColor(dark ? "#262626" : "#ffffff"));
    p.setColor(QPalette::AlternateBase, QColor(dark ? "#2d2d2d" : "#f7f7f7"));
    p.setColor(QPalette::Highlight, QColor(dark ? "#3d8bfd" : "#308cc6"));
    p.setColor(QPalette::HighlightedText, QColor("#ffffff"));
    p.setColor(QPalette::PlaceholderText, QColor(dark ? "#8a8a8a" : "#808080"));
    if (dark) {
        p.setColor(QPalette::ToolTipBase, QColor("#2d2d2d"));
        p.setColor(QPalette::ToolTipText, QColor("#e6e6e6"));
    }
    for (auto role : {QPalette::WindowText, QPalette::Text, QPalette::ButtonText})
        p.setColor(QPalette::Disabled, role, QColor(dark ? "#7a7a7a" : "#a0a0a0"));
    return p;
}

QPixmap trayPixmap(bool filled, int running, const QPalette &p, bool attention)
{
    const QColor halo = p.color(QPalette::Window), fg = p.color(QPalette::WindowText);
    const QPolygonF top{{32, 6}, {58, 19}, {32, 32}, {6, 19}};
    QPainterPath paths;
    paths.addPolygon(top);
    paths.closeSubpath();
    paths.addPolygon(QPolygonF{{6, 31}, {32, 44}, {58, 31}});
    paths.addPolygon(QPolygonF{{6, 43}, {32, 56}, {58, 43}});

    QPixmap pm(64, 64);
    pm.setDevicePixelRatio(1);
    pm.fill(Qt::transparent);
    QPainter g(&pm);
    g.setRenderHint(QPainter::Antialiasing);
    g.setBrush(Qt::NoBrush);
    g.setPen(QPen(halo, 9, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
    g.drawPath(paths);
    if (filled && !attention) {
        g.setPen(Qt::NoPen);
        g.setBrush(p.color(QPalette::Highlight));
        g.drawPolygon(top);
        g.setBrush(Qt::NoBrush);
    }
    g.setPen(QPen(fg, 5, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
    g.drawPath(paths);

    if (attention || running > 0) {
        const QPointF centre(48, 48);
        g.setPen(Qt::NoPen);
        g.setBrush(halo);
        g.drawEllipse(centre, 17, 17);
        g.setBrush(attention ? Orange : p.color(QPalette::Highlight));
        g.drawEllipse(centre, 15, 15);
        const bool many = !attention && running > 9;
        QFont font;
        font.setBold(true);
        font.setPixelSize(many ? 18 : 22);
        g.setFont(font);
        g.setPen(attention ? Qt::white : p.color(QPalette::HighlightedText));
        g.drawText(QRectF(centre.x() - 15, centre.y() - 15, 30, 30), Qt::AlignCenter,
                   attention ? QStringLiteral("!") : (many ? QStringLiteral("9+") : QString::number(running)));
    }
    return pm;
}
