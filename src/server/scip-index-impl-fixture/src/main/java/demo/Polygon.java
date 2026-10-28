package demo;

public abstract class Polygon implements Shape {
    abstract int sides();

    @Override
    public String label() {
        return "polygon " + sides();
    }
}
