package demo;

public interface Shape {
    double area();

    default String label() {
        return "shape";
    }
}
