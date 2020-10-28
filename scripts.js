$(document).ready( function() {
    $("#header-wrapper").load("header.html");

    $(".fa-caret-square-up").on("click", function() {
        $(".fa-caret-square-up").toggleClass("rotate");
        $(".visualizer-gifs").toggleClass("slide");
    });
});