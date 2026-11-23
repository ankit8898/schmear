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
set_tests_properties(render render-dark PROPERTIES ENVIRONMENT QT_QPA_PLATFORM=offscreen)

install(TARGETS schmear-tray)
configure_file(schmear-tray.desktop.in schmear-tray.desktop @ONLY)
install(FILES ${CMAKE_CURRENT_BINARY_DIR}/schmear-tray.desktop DESTINATION ${CMAKE_INSTALL_DATADIR}/applications)
install(FILES schmear-tray.svg DESTINATION ${CMAKE_INSTALL_DATADIR}/icons/hicolor/scalable/apps)
