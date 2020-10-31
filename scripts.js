$(document).ready( function() {
    $("#header-wrapper").load("header.html");

    $(".preview-toggle").on("click", function() {
        $(".fa-caret-square-up").toggleClass("rotate");
        $(".visualizer-gifs").toggleClass("slide");
    });
});