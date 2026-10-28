package demo;

public class Square extends Polygon {
    private final double side;

    public Square(double side) {
        this.side = side;
    }

    @Override
    public double area() {
        return side * side;
    }

    @Override
    int sides() {
        return 4;
    }
}
