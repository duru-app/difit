package demo;

public class Ring extends Circle {
    public Ring(double radius) {
        super(radius);
    }

    @Override
    public String unit() {
        return "mm";
    }
}
