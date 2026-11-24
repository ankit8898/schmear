cmake_minimum_required(VERSION 3.22)
project(schmear-tray LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Qt6 6.4 REQUIRED COMPONENTS Widgets Network Test)
qt_standard_project_setup()
add_compile_options(-Wall -Wextra)

set(FIXTURES ${CMAKE_CURRENT_SOURCE_DIR}/../macos/Tests/SchmearKitTests/Fixtures)

# Headers are globbed so AUTOMOC sees Q_OBJECT classes.
file(GLOB kit_sources CONFIGURE_DEPENDS src/kit/*.cpp src/kit/*.h)
add_library(schmearkit STATIC ${kit_sources})
target_include_directories(schmearkit PUBLIC src/kit)
target_link_libraries(schmearkit PUBLIC Qt6::Gui Qt6::Network)

enable_testing()
file(GLOB test_sources CONFIGURE_DEPENDS tests/tst_*.cpp)
foreach(test_source ${test_sources})
    get_filename_component(test_name ${test_source} NAME_WE)
    add_executable(${test_name} ${test_source})
    target_link_libraries(${test_name} PRIVATE schmearkit Qt6::Test)
    target_compile_definitions(${test_name} PRIVATE SCHMEAR_FIXTURES="${FIXTURES}")
    add_test(NAME ${test_name} COMMAND ${test_name})
    set_tests_properties(${test_name} PROPERTIES ENVIRONMENT QT_QPA_PLATFORM=offscreen)
endforeach()

file(GLOB app_sources CONFIGURE_DEPENDS src/app/*.cpp src/app/*.h)
qt_add_executable(schmear-tray ${app_sources})
target_link_libraries(schmear-tray PRIVATE schmearkit Qt6::Widgets)

add_test(NAME render COMMAND schmear-tray --render ${FIXTURES}/snapshot.json ${CMAKE_CURRENT_BINARY_DIR}/render.png)
add_test(NAME render-dark COMMAND schmear-tray --render ${FIXTURES}/snapshot.json ${CMAKE_CURRENT_BINARY_DIR}/render-dark.png --dark)
add_test(NAME render-tiers COMMAND schmear-tray --render-tiers ${FIXTURES}/tiers.json ${CMAKE_CURRENT_BINARY_DIR}/render-tiers.png)
add_test(NAME render-tiers-dark COMMAND schmear-tray --render-tiers ${FIXTURES}/tiers.json ${CMAKE_CURRENT_BINARY_DIR}/render-tiers-dark.png --dark)
set_tests_properties(render render-dark render-tiers render-tiers-dark PROPERTIES ENVIRONMENT QT_QPA_PLATFORM=offscreen)

# `cmake --install --prefix <dir>` stages the release archive's flat layout; <dir>/install.sh installs it.
# The archive runs against the system Qt, never a Qt that happens to sit beside it.
set_target_properties(schmear-tray PROPERTIES INSTALL_RPATH "")
install(TARGETS schmear-tray DESTINATION .)
install(FILES schmear-tray.svg ../LICENSE DESTINATION .)
install(PROGRAMS install.sh DESTINATION .)

add_test(NAME install WORKING_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR} COMMAND sh -c [=[
set -eu
rm -rf stage home
DESTDIR= "$0" --install . --prefix stage >/dev/null
test "$(LC_ALL=C ls stage | tr '\n' ' ')" = "LICENSE install.sh schmear-tray schmear-tray.svg "
mkdir -p home/.config/autostart
printf '[Desktop Entry]\nExec="/old/schmear-tray"\nHidden=true\n' >home/.config/autostart/schmear-tray.desktop
HOME="$PWD/home" XDG_DATA_HOME= XDG_CONFIG_HOME= stage/install.sh
exec="Exec=\"$PWD/home/.local/bin/schmear-tray\""
test -x home/.local/bin/schmear-tray
test -f home/.local/share/icons/hicolor/scalable/apps/schmear-tray.svg
grep -qxF "$exec" home/.local/share/applications/schmear-tray.desktop
grep -qxF "$exec" home/.config/autostart/schmear-tray.desktop
grep -qxF Hidden=true home/.config/autostart/schmear-tray.desktop
]=] ${CMAKE_COMMAND})
