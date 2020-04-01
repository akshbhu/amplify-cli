package InvocationShim;
import com.amazonaws.services.lambda.runtime.Context;
import com.google.gson.Gson;
import org.json.simple.JSONObject;
import org.json.simple.parser.JSONParser;
import org.json.simple.parser.ParseException;
import java.lang.reflect.*;
import java.io.FileReader;
import java.io.IOException;
import java.io.Reader;

public class Program {

    public static void main(String[] args) throws IllegalAccessException, InstantiationException, NoSuchMethodException, InvocationTargetException, ClassNotFoundException {
        // read the jSON file to JSON object
        JSONParser parser = new JSONParser();
        JSONObject jsonObject = null;
        String  eventFile = args[1];
        MockContext ct  = new MockContext();
        //reflection
        String handlerName = args[0].split("::")[1];
        String className = args[0].split("::")[0];
        // loading class name and handler name based on the input passed
        Class<?> cl = Class.forName(className);
        Constructor<?> cons = cl.getConstructor();
        Object obj = cons.newInstance();
        Class cls = obj.getClass();
        // getting methods of the handler class
        Method[] methods = cls.getMethods();

        // checking the interface used for the lambda invocation
        if(cls.getInterfaces()[0].getName().indexOf("RequestHandler") != -1) {
            // converting the json object to the java object
            var eventObj = new Gson().fromJson(eventFile, (Type) methods[0].getParameterTypes()[0]);
            // getting the handler name
            Method m = cls.getDeclaredMethod(handlerName, (Class<?>) methods[0].getParameterTypes()[0], Context.class);
            // invoking the handler function
            Object response = m.invoke(obj, eventObj, new MockContext());
            System.out.println(new Gson().toJson(response));
        }
        else{
            // implement for requestStreamHandler
        }
    }
}