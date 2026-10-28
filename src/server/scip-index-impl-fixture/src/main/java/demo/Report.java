package demo;

import java.util.List;
import lombok.Builder;

@Builder
public class Report {
    private final List<Shape> shapes;

    public double total() {
        double sum = 0;
        for (Shape shape : shapes) {
            sum += shape.area();
        }
        return sum;
    }

    public String summary() {
        shapes.forEach(shape -> describe(shape));
        return "total " + total();
    }

    void describe(Shape shape) {
        Runnable task = new Runnable() {
            @Override
            public void run() {
                shape.label();
            }
        };
        task.run();
    }

    int countdown(int n) {
        return n <= 0 ? 0 : countdown(n - 1);
    }
}
